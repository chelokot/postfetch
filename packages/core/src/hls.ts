import { concat } from "./isobmff";
import type { Net } from "./internal";

// HLS support for the fMP4/CMAF playlists reddit-style muxing already covers:
// a media playlist is an EXT-X-MAP init plus media segments (often byte ranges of
// one CMAF file), so assembling it is just fetching those byte ranges in order and
// concatenating them into a fragmented MP4. No MPEG-TS demuxing is involved.

type Segment = { url: string; range: { length: number; offset: number } | null };

export type HlsVariant = { width: number; height: number; bandwidth: number; url: string; audioGroup: string | null };
export type HlsMaster = { variants: HlsVariant[]; audio: Record<string, string> };

export function isMasterPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

export function parseMaster(text: string, baseUrl: string): HlsMaster {
  const lines = text.split("\n").map((line) => line.trim());
  const audio: Record<string, string> = {};
  const variants: HlsVariant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
      const group = line.match(/GROUP-ID="([^"]+)"/)?.[1];
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (group && uri) {
        audio[group] = new URL(uri, baseUrl).href;
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const target = lines[index + 1];
      if (target && !target.startsWith("#")) {
        const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
        variants.push({
          width: resolution ? Number(resolution[1]) : 0,
          height: resolution ? Number(resolution[2]) : 0,
          bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0),
          url: new URL(target, baseUrl).href,
          audioGroup: line.match(/AUDIO="([^"]+)"/)?.[1] ?? null,
        });
      }
    }
  }
  return { variants, audio };
}

export async function assembleHls(net: Net, playlistUrl: string, headers: HeadersInit): Promise<Uint8Array> {
  const response = await net(playlistUrl, { headers });
  if (!response.ok) {
    throw new Error(`HLS playlist failed: ${response.status}`);
  }
  const segments = mediaSegments(await response.text(), playlistUrl);
  if (segments.length === 0) {
    throw new Error("HLS playlist has no segments");
  }
  return concat(await fetchSegments(net, segments, headers));
}

function mediaSegments(text: string, baseUrl: string): Segment[] {
  const segments: Segment[] = [];
  let pendingRange: { length: number; offset: number } | null = null;
  let nextOffset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) {
        const range = byteRange(line.match(/BYTERANGE="([^"]+)"/)?.[1], nextOffset);
        segments.push({ url: new URL(uri, baseUrl).href, range });
        nextOffset = range ? range.offset + range.length : nextOffset;
      }
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = byteRange(line.slice("#EXT-X-BYTERANGE:".length), nextOffset);
      nextOffset = pendingRange ? pendingRange.offset + pendingRange.length : nextOffset;
    } else if (line.length > 0 && !line.startsWith("#")) {
      segments.push({ url: new URL(line, baseUrl).href, range: pendingRange });
      pendingRange = null;
    }
  }
  return segments;
}

// EXT-X-BYTERANGE is `length[@offset]`; a missing offset continues from the end of
// the previous sub-range of the same resource.
function byteRange(spec: string | undefined, runningOffset: number): { length: number; offset: number } | null {
  const match = spec?.trim().match(/^(\d+)(?:@(\d+))?$/);
  if (!match) {
    return null;
  }
  return { length: Number(match[1]), offset: match[2] === undefined ? runningOffset : Number(match[2]) };
}

// Segments are fetched with a small concurrency window: parallel enough to be fast,
// bounded so a long playlist does not open hundreds of sockets at once.
async function fetchSegments(net: Net, segments: Segment[], headers: HeadersInit): Promise<Uint8Array[]> {
  const results = new Array<Uint8Array>(segments.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < segments.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchSegment(net, segments[index], headers);
    }
  }
  const workers = Array.from({ length: Math.min(8, segments.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchSegment(net: Net, segment: Segment, headers: HeadersInit): Promise<Uint8Array> {
  const requestHeaders = new Headers(headers);
  if (segment.range) {
    requestHeaders.set("range", `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}`);
  }
  const response = await net(segment.url, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`HLS segment failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
