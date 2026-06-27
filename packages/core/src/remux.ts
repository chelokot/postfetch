import {
  boxVersion,
  buildBox,
  childBoxes,
  concat,
  findBox,
  parseBoxes,
  readU32,
  sliceBox,
  writeU32,
  type Box,
} from "./isobmff";

// A single-track fragmented MP4 (CMAF init segment + moof/mdat fragments), broken
// into the parts a merge needs.
type Source = {
  data: Uint8Array;
  ftyp: Box;
  moov: Box;
  trak: Box;
  mvex: Box;
  trackId: number;
  fragments: { moof: Box; mdat: Box }[];
};

/**
 * Merge a video-only and an audio-only fragmented MP4 into one file with both
 * tracks. The DASH/CMAF streams reddit and YouTube hand out keep video and audio
 * apart; this recombines them without re-encoding — every `moof`/`mdat` pair is
 * copied verbatim (so each `trun` data offset stays valid) and only the track id
 * and fragment sequence number are patched.
 */
export function mergeAudioVideo(video: Uint8Array, audio: Uint8Array): Uint8Array {
  const videoSource = analyze(video);
  const audioSource = analyze(audio);
  const audioTrackId = videoSource.trackId === 1 ? 2 : 1;

  const moov = buildMoov(videoSource, audioSource, audioTrackId);
  const parts: Uint8Array[] = [sliceBox(video, videoSource.ftyp), moov];

  let sequence = 1;
  const fragmentCount = Math.max(videoSource.fragments.length, audioSource.fragments.length);
  for (let index = 0; index < fragmentCount; index += 1) {
    const videoFragment = videoSource.fragments[index];
    if (videoFragment) {
      // The patched moof is a small copy; the (large) mdat is appended as a view,
      // so the trailing concat is the only time sample bytes are copied.
      parts.push(rewriteMoof(video, videoFragment.moof, null, sequence));
      parts.push(video.subarray(videoFragment.mdat.start, videoFragment.mdat.end));
      sequence += 1;
    }
    const audioFragment = audioSource.fragments[index];
    if (audioFragment) {
      parts.push(rewriteMoof(audio, audioFragment.moof, audioTrackId, sequence));
      parts.push(audio.subarray(audioFragment.mdat.start, audioFragment.mdat.end));
      sequence += 1;
    }
  }
  return concat(parts);
}

function analyze(data: Uint8Array): Source {
  const top = parseBoxes(data);
  const ftyp = findBox(top, "ftyp");
  const moov = findBox(top, "moov");
  if (!ftyp || !moov) {
    throw new Error("not a fragmented MP4");
  }
  const moovChildren = childBoxes(data, moov);
  const trak = findBox(moovChildren, "trak");
  const mvex = findBox(moovChildren, "mvex");
  if (!trak || !mvex) {
    throw new Error("MP4 is not fragmented (no trak/mvex)");
  }
  const tkhd = findBox(childBoxes(data, trak), "tkhd");
  if (!tkhd) {
    throw new Error("track header not found");
  }
  const fragments: { moof: Box; mdat: Box }[] = [];
  for (let index = 0; index < top.length; index += 1) {
    if (top[index].type === "moof") {
      const mdat = top[index + 1];
      if (!mdat || mdat.type !== "mdat") {
        throw new Error("fragment without mdat");
      }
      fragments.push({ moof: top[index], mdat });
    }
  }
  if (fragments.length === 0) {
    throw new Error("MP4 has no fragments");
  }
  return { data, ftyp, moov, trak, mvex, trackId: trackHeaderId(data, tkhd), fragments };
}

// next_track_ID is the last uint32 of mvhd; track_ID sits after the version-sized
// creation/modification timestamps in tkhd.
function trackHeaderId(data: Uint8Array, tkhd: Box): number {
  return readU32(data, tkhd.dataStart + (boxVersion(data, tkhd) === 1 ? 20 : 12));
}

function buildMoov(video: Source, audio: Source, audioTrackId: number): Uint8Array {
  const moovChildren = childBoxes(video.data, video.moov);
  const mvhd = patchedMvhd(video, audioTrackId);
  const meta = findBox(moovChildren, "meta");
  const videoTrak = sliceBox(video.data, video.trak);
  const audioTrak = retrackTrak(sliceBox(audio.data, audio.trak), audioTrackId);
  const mvex = buildMvex(video, audio, audioTrackId);

  const children = [mvhd];
  if (meta) {
    children.push(sliceBox(video.data, meta));
  }
  children.push(videoTrak, audioTrak, mvex);
  return buildBox("moov", concat(children));
}

function patchedMvhd(video: Source, audioTrackId: number): Uint8Array {
  const mvhd = findBox(childBoxes(video.data, video.moov), "mvhd");
  if (!mvhd) {
    throw new Error("movie header not found");
  }
  const copy = sliceBox(video.data, mvhd);
  writeU32(copy, copy.length - 4, Math.max(video.trackId, audioTrackId) + 1);
  return copy;
}

function buildMvex(video: Source, audio: Source, audioTrackId: number): Uint8Array {
  const videoMvex = childBoxes(video.data, video.mvex);
  const mehd = findBox(videoMvex, "mehd");
  const videoTrex = findBox(videoMvex, "trex");
  const audioTrex = findBox(childBoxes(audio.data, audio.mvex), "trex");
  if (!videoTrex || !audioTrex) {
    throw new Error("track extends box not found");
  }
  const audioTrexCopy = sliceBox(audio.data, audioTrex);
  writeU32(audioTrexCopy, audioTrex.dataStart - audioTrex.start + 4, audioTrackId);

  const children: Uint8Array[] = [];
  if (mehd) {
    children.push(sliceBox(video.data, mehd));
  }
  children.push(sliceBox(video.data, videoTrex), audioTrexCopy);
  return buildBox("mvex", concat(children));
}

function retrackTrak(trak: Uint8Array, trackId: number): Uint8Array {
  const tkhd = findBox(parseBoxes(trak, 8, trak.length), "tkhd");
  if (!tkhd) {
    throw new Error("track header not found");
  }
  writeU32(trak, tkhd.dataStart + (boxVersion(trak, tkhd) === 1 ? 20 : 12), trackId);
  return trak;
}

function rewriteMoof(data: Uint8Array, moofBox: Box, trackId: number | null, sequence: number): Uint8Array {
  const moof = sliceBox(data, moofBox);
  const moofChildren = parseBoxes(moof, 8, moof.length);
  const mfhd = findBox(moofChildren, "mfhd");
  if (!mfhd) {
    throw new Error("movie fragment header not found");
  }
  writeU32(moof, mfhd.dataStart + 4, sequence);
  if (trackId !== null) {
    const traf = findBox(moofChildren, "traf");
    const tfhd = traf ? findBox(parseBoxes(moof, traf.dataStart, traf.end), "tfhd") : undefined;
    if (!tfhd) {
      throw new Error("track fragment header not found");
    }
    writeU32(moof, tfhd.dataStart + 4, trackId);
  }
  return moof;
}
