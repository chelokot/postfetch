import { describe, expect, test } from "bun:test";
import { assembleHls, isMasterPlaylist, parseMaster } from "../src/hls";
import { createNet } from "../src/internal";

// A fetch stub that serves fixed bodies per URL prefix and honours Range requests
// (needed for byte-range HLS segments).
function stubFetch(routes: Record<string, Uint8Array | string>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) {
      return new Response("not found", { status: 404 });
    }
    const value = routes[key];
    if (typeof value === "string") {
      return new Response(value);
    }
    const range = new Headers(init?.headers).get("range");
    const match = range?.match(/bytes=(\d+)-(\d+)/);
    const body = match ? value.subarray(Number(match[1]), Number(match[2]) + 1) : value;
    return new Response(new Uint8Array(body));
  }) as typeof fetch;
}

describe("parseMaster", () => {
  test("reads variants and the audio group", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",NAME="1",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=378552,RESOLUTION=234x416,AUDIO="audio1"',
      "240w.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=896408,RESOLUTION=486x864,AUDIO="audio1"',
      "486w.m3u8",
    ].join("\n");
    const master = parseMaster(text, "https://cdn.test/v/master.m3u8");

    expect(isMasterPlaylist(text)).toBe(true);
    expect(master.audio).toEqual({ audio1: "https://cdn.test/v/audio.m3u8" });
    expect(master.variants).toEqual([
      { width: 234, height: 416, bandwidth: 378552, url: "https://cdn.test/v/240w.m3u8", audioGroup: "audio1" },
      { width: 486, height: 864, bandwidth: 896408, url: "https://cdn.test/v/486w.m3u8", audioGroup: "audio1" },
    ]);
  });
});

describe("assembleHls", () => {
  test("concatenates an init segment and separate media segments", async () => {
    const playlist = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:2", "seg0.m4s", "#EXTINF:2", "seg1.m4s"].join("\n");
    const net = createNet(
      stubFetch({
        "https://cdn.test/a/playlist.m3u8": playlist,
        "https://cdn.test/a/init.mp4": Uint8Array.of(1, 2),
        "https://cdn.test/a/seg0.m4s": Uint8Array.of(3, 4),
        "https://cdn.test/a/seg1.m4s": Uint8Array.of(5, 6),
      }),
    );
    const bytes = await assembleHls(net, "https://cdn.test/a/playlist.m3u8", {});
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("fetches byte-range segments of a single CMAF file", async () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="data.cmfv",BYTERANGE="2@0"',
      "#EXTINF:2",
      "#EXT-X-BYTERANGE:3@2",
      "data.cmfv",
      "#EXTINF:2",
      "#EXT-X-BYTERANGE:2@5",
      "data.cmfv",
    ].join("\n");
    const net = createNet(
      stubFetch({
        "https://cdn.test/b/playlist.m3u8": playlist,
        "https://cdn.test/b/data.cmfv": Uint8Array.of(10, 11, 12, 13, 14, 15, 16),
      }),
    );
    const bytes = await assembleHls(net, "https://cdn.test/b/playlist.m3u8", {});
    expect([...bytes]).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });
});
