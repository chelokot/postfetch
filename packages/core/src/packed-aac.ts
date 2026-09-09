import { buildBox, concat, readU32, writeU32 } from "./isobmff";

// YouTube's fMP4 HLS video is paired with packed AAC: each audio segment is
// ID3 (including a 90 kHz timestamp) followed by ADTS frames. Strip the transport
// headers and put the original AAC samples into CMAF fragments for our merger.
type Config = { frequencyIndex: number; sampleRate: number; channels: number };
type Fragment = { samples: Uint8Array[]; timestamp: number };
const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const encoder = new TextEncoder();

export function packedAacToMp4(segments: Uint8Array[]): Uint8Array | null {
  const first = segments[0];
  if (!first || (!id3(first, 0) && !adts(first, 0))) {
    return null;
  }
  let config: Config | undefined;
  let nextTimestamp = 0;
  const fragments: Fragment[] = [];
  for (const segment of segments) {
    let offset = 0;
    let timestamp: number | undefined;
    while (id3(segment, offset)) {
      const tag = readId3(segment, offset);
      timestamp ??= tag.timestamp;
      offset = tag.end;
    }
    const samples: Uint8Array[] = [];
    while (offset < segment.length) {
      if (offset + 7 > segment.length || !adts(segment, offset)) {
        throw new Error("Invalid packed AAC frame");
      }
      const profile = (segment[offset + 2] >> 6) + 1;
      const frequencyIndex = (segment[offset + 2] >> 2) & 15;
      const sampleRate = sampleRates[frequencyIndex];
      const channels = ((segment[offset + 2] & 1) << 2) | (segment[offset + 3] >> 6);
      if (profile !== 2 || !sampleRate || sampleRate > 65535 || channels === 0 || (segment[offset + 6] & 3) !== 0) {
        throw new Error("Unsupported packed AAC configuration (expected AAC-LC)");
      }
      if (config && (config.frequencyIndex !== frequencyIndex || config.channels !== channels)) {
        throw new Error("Packed AAC configuration changed between frames");
      }
      config ??= { frequencyIndex, sampleRate, channels };
      const length = ((segment[offset + 3] & 3) << 11) | (segment[offset + 4] << 3) | (segment[offset + 5] >> 5);
      const headerLength = segment[offset + 1] & 1 ? 7 : 9;
      if (length <= headerLength || offset + length > segment.length) {
        throw new Error("Truncated packed AAC frame");
      }
      samples.push(segment.subarray(offset + headerLength, offset + length));
      offset += length;
    }
    if (!config || samples.length === 0) {
      throw new Error("Packed AAC segment has no audio frames");
    }
    const start = timestamp === undefined ? nextTimestamp : Math.round(timestamp * config.sampleRate / 90000);
    fragments.push({ samples, timestamp: start });
    nextTimestamp = start + samples.length * 1024;
  }
  return concat([initSegment(config!), ...fragments.flatMap((fragment, index) => mediaFragment(fragment, index + 1))]);
}

function id3(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset] === 0x49 && bytes[offset + 1] === 0x44 && bytes[offset + 2] === 0x33;
}

function adts(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset] === 0xff && (bytes[offset + 1] & 0xf6) === 0xf0;
}

function synchsafe(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length || bytes.subarray(offset, offset + 4).some((byte) => byte & 128)) {
    throw new Error("Invalid packed AAC ID3 size");
  }
  return bytes[offset] * 2 ** 21 + bytes[offset + 1] * 2 ** 14 + bytes[offset + 2] * 128 + bytes[offset + 3];
}

function readId3(bytes: Uint8Array, offset: number): { end: number; timestamp?: number } {
  const version = bytes[offset + 3];
  if (offset + 10 > bytes.length || (version !== 3 && version !== 4) || (bytes[offset + 5] & 0xc0)) {
    throw new Error("Unsupported packed AAC ID3 tag");
  }
  const end = offset + 10 + synchsafe(bytes, offset + 6);
  if (end > bytes.length) {
    throw new Error("Truncated packed AAC ID3 tag");
  }
  const owner = encoder.encode("com.apple.streaming.transportStreamTimestamp\0");
  let timestamp: number | undefined;
  for (let cursor = offset + 10; cursor + 10 <= end && bytes[cursor] !== 0;) {
    const size = version === 4 ? synchsafe(bytes, cursor + 4) : readU32(bytes, cursor + 4);
    const body = cursor + 10;
    if (body + size > end) {
      throw new Error("Truncated packed AAC ID3 frame");
    }
    if (String.fromCharCode(...bytes.subarray(cursor, cursor + 4)) === "PRIV" &&
      size === owner.length + 8 && owner.every((byte, index) => bytes[body + index] === byte)) {
      if (bytes[cursor + 8] !== 0 || bytes[cursor + 9] !== 0) {
        throw new Error("Unsupported packed AAC timestamp encoding");
      }
      timestamp = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(body + owner.length) & 0x1ffffffffn);
    }
    cursor = body + size;
  }
  const footer = version === 4 && (bytes[offset + 5] & 0x10) ? 10 : 0;
  if (end + footer > bytes.length) {
    throw new Error("Truncated packed AAC ID3 footer");
  }
  return { end: end + footer, timestamp };
}

function u32(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, index) => writeU32(bytes, index * 4, value));
  return bytes;
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  return buildBox(type, concat([u32(version * 0x1000000 + flags), payload]));
}

function matrix(bytes: Uint8Array, offset: number): void {
  bytes.set(u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000), offset);
}

function initSegment(config: Config): Uint8Array {
  const mvhd = new Uint8Array(96);
  writeU32(mvhd, 8, 1000);
  writeU32(mvhd, 16, 0x10000);
  new DataView(mvhd.buffer).setUint16(20, 0x100);
  matrix(mvhd, 32);
  writeU32(mvhd, 92, 2);
  const tkhd = new Uint8Array(80);
  writeU32(tkhd, 8, 1);
  new DataView(tkhd.buffer).setUint16(32, 0x100);
  matrix(tkhd, 36);
  const mdhd = concat([u32(0, 0, config.sampleRate, 0), Uint8Array.of(0x55, 0xc4, 0, 0)]);
  const hdlr = concat([u32(0), encoder.encode("soun"), u32(0, 0, 0), encoder.encode("SoundHandler\0")]);
  const stbl = buildBox("stbl", concat([
    fullBox("stsd", 0, 0, concat([u32(1), sampleEntry(config)])),
    ...["stts", "stsc", "stco"].map((type) => fullBox(type, 0, 0, u32(0))),
    fullBox("stsz", 0, 0, u32(0, 0)),
  ]));
  const minf = buildBox("minf", concat([
    fullBox("smhd", 0, 0, u32(0)),
    buildBox("dinf", fullBox("dref", 0, 0, concat([u32(1), fullBox("url ", 0, 1, new Uint8Array())]))),
    stbl,
  ]));
  const trak = buildBox("trak", concat([
    fullBox("tkhd", 0, 7, tkhd),
    buildBox("mdia", concat([fullBox("mdhd", 0, 0, mdhd), fullBox("hdlr", 0, 0, hdlr), minf])),
  ]));
  return concat([
    buildBox("ftyp", concat([encoder.encode("isom"), u32(512), encoder.encode("isomiso6mp41")])),
    buildBox("moov", concat([
      fullBox("mvhd", 0, 0, mvhd), trak,
      buildBox("mvex", fullBox("trex", 0, 0, u32(1, 1, 1024, 0, 0x02000000))),
    ])),
  ]);
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  // The fixed AAC-LC descriptors below are all shorter than 128 bytes.
  return concat([Uint8Array.of(tag, payload.length), payload]);
}

function sampleEntry(config: Config): Uint8Array {
  const entry = new Uint8Array(28);
  const view = new DataView(entry.buffer);
  view.setUint16(6, 1);
  view.setUint16(16, config.channels === 7 ? 8 : config.channels);
  view.setUint16(18, 16);
  view.setUint32(24, config.sampleRate * 65536);
  const asc = Uint8Array.of((2 << 3) | (config.frequencyIndex >> 1), ((config.frequencyIndex & 1) << 7) | (config.channels << 3));
  const decoder = descriptor(4, concat([Uint8Array.of(0x40, 0x15, 0, 0, 0), u32(0, 0), descriptor(5, asc)]));
  const esds = descriptor(3, concat([Uint8Array.of(0, 1, 0), decoder, descriptor(6, Uint8Array.of(2))]));
  return buildBox("mp4a", concat([entry, fullBox("esds", 0, 0, esds)]));
}

function mediaFragment(fragment: Fragment, sequence: number): Uint8Array[] {
  const timestamp = new Uint8Array(8);
  new DataView(timestamp.buffer).setBigUint64(0, BigInt(fragment.timestamp));
  const trun = fullBox("trun", 0, 0x201, concat([u32(fragment.samples.length, 0), u32(...fragment.samples.map((sample) => sample.length))]));
  const moof = buildBox("moof", concat([
    fullBox("mfhd", 0, 0, u32(sequence)),
    buildBox("traf", concat([fullBox("tfhd", 0, 0x020000, u32(1)), fullBox("tfdt", 1, 0, timestamp), trun])),
  ]));
  writeU32(moof, moof.length - trun.length + 16, moof.length + 8);
  return [moof, buildBox("mdat", concat(fragment.samples))];
}
