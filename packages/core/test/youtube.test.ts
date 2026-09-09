import { describe, expect, test } from "bun:test";
import { youtubeVideoId } from "../src/youtube";
import { postfetch } from "../src/index";

describe("youtube url parsing", () => {
  test("extracts watch, shorts, live, embed and youtu.be ids", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=vPwaXytZcgI")).toBe("vPwaXytZcgI");
    expect(youtubeVideoId("https://www.youtube.com/shorts/r5FpeOJItbw")).toBe("r5FpeOJItbw");
    expect(youtubeVideoId("https://www.youtube.com/live/ENxZS6PUDuI?feature=shared")).toBe("ENxZS6PUDuI");
    expect(youtubeVideoId("https://www.youtube.com/embed/vPwaXytZcgI")).toBe("vPwaXytZcgI");
    expect(youtubeVideoId("https://youtu.be/vPwaXytZcgI")).toBe("vPwaXytZcgI");
  });

  test("rejects non-video youtube links", () => {
    expect(youtubeVideoId("https://www.youtube.com/@youtube")).toBeNull();
  });
});

const manifest = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Original",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Dub",DEFAULT=NO,URI="dub.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=720x1280,AUDIO="aac"',
  "ts-video.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="vp09.00.21.08,mp4a.40.2",RESOLUTION=360x640,AUDIO="aac"',
  "small.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1700000,CODECS="vp09.00.31.08,mp4a.40.2",RESOLUTION=720x1280,AUDIO="aac"',
  "video.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2700000,CODECS="vp09.00.40.08,mp4a.40.2",RESOLUTION=1080x1920,AUDIO="aac"',
  "large.m3u8",
].join("\n");

function youtubeFetch(options: {
  videoStatus?: number;
  audioStatus?: number;
  androidUnavailable?: boolean;
  missingSession?: boolean;
  visionUnavailable?: boolean;
  missingManifest?: boolean;
  manifest?: string;
  playlist?: string;
} = {}) {
  const clients: string[] = [];
  const probes: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("youtube.com/watch")) {
      return new Response(options.missingSession ? "no session" : '"visitorData":"visitor-123","jsUrl":"/s/player/test/base.js"');
    }
    if (url.includes("/s/player/")) return new Response("signatureTimestamp:20000");
    if (url.includes("/youtubei/v1/player")) {
      const body = JSON.parse(String(init?.body));
      const client = body.context.client.clientName;
      clients.push(client);
      if (client === "ANDROID_VR") {
        return Response.json({
          playabilityStatus: { status: options.androidUnavailable ? "ERROR" : "OK", reason: "Android unavailable" },
          streamingData: { adaptiveFormats: [
            { url: "https://cdn.test/direct-video.mp4", mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 720 },
            { url: "https://cdn.test/direct-audio.m4a", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
          ] },
          videoDetails: { title: "Direct clip" },
        });
      }
      expect(client).toBe("VISIONOS");
      expect(new Headers(init?.headers).get("x-youtube-client-name")).toBe("101");
      expect(body.videoId).toBe("7KZQlvBXphg");
      expect(body.context.client.visitorData).toBe(options.missingSession ? undefined : "visitor-123");
      return Response.json({
        playabilityStatus: { status: options.visionUnavailable ? "LOGIN_REQUIRED" : "OK", reason: "Sign in required" },
        streamingData: options.missingManifest ? {} : { hlsManifestUrl: "https://cdn.test/master.m3u8" },
        videoDetails: { title: "Fallback clip", author: "Creator", lengthSeconds: "67" },
      });
    }
    if (url.includes("/direct-")) {
      probes.push(url);
      // The real CDN accepts a Range probe while rejecting the full GET.
      if (new Headers(init?.headers).has("range") || init?.method === "HEAD") {
        return new Response(Uint8Array.of(0), { status: 206 });
      }
      return new Response(Uint8Array.of(0), { status: (url.includes("audio") ? options.audioStatus : options.videoStatus) ?? 200 });
    }
    if (url.endsWith("/master.m3u8")) return new Response(options.manifest ?? manifest);
    if (url.endsWith(".m3u8")) {
      expect(new Headers(init?.headers).get("user-agent")).toContain("Safari");
      return new Response(options.playlist ?? '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST');
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, clients, probes };
}

describe("YouTube client fallback", () => {
  const url = "https://www.youtube.com/shorts/7KZQlvBXphg";

  test("keeps working direct streams and probes both tracks", async () => {
    const stub = youtubeFetch();
    const result = await postfetch(url, stub);
    expect(result.items[0].url).toBe("https://cdn.test/direct-video.mp4");
    expect(result.items[0].hls).toBeUndefined();
    expect(stub.clients).toEqual(["ANDROID_VR"]);
    expect(stub.probes).toHaveLength(2);
  });

  for (const track of ["video", "audio"] as const) {
    test(`falls back when the direct ${track} stream returns 403`, async () => {
      const stub = youtubeFetch({ [`${track}Status`]: 403 });
      const result = await postfetch(url, stub);
      expect(stub.clients).toEqual(["ANDROID_VR", "VISIONOS"]);
      expect(result.items[0]).toMatchObject({
        hls: true, mime: "video/mp4", url: "https://cdn.test/video.m3u8",
        audio: { url: "https://cdn.test/audio.m3u8" },
      });
      expect(result.metadata).toMatchObject({ title: "Fallback clip", author: { name: "Creator" } });
    });
  }

  test("uses the preferred width when selecting a supported HLS variant", async () => {
    const stub = youtubeFetch({ videoStatus: 403 });
    const result = await postfetch(url, { ...stub, preferredWidth: 1080 });
    expect(result.items[0].url).toBe("https://cdn.test/large.m3u8");
  });

  test("falls back when the Android player is unavailable", async () => {
    const stub = youtubeFetch({ androidUnavailable: true });
    expect((await postfetch(url, stub)).items[0].hls).toBe(true);
    expect(stub.probes).toHaveLength(0);
  });

  test("can use visionOS without the Android session bootstrap", async () => {
    const stub = youtubeFetch({ missingSession: true });
    expect((await postfetch(url, stub)).items[0].hls).toBe(true);
    expect(stub.clients).toEqual(["VISIONOS"]);
  });

  test("reports both client failures instead of returning a blocked URL", async () => {
    await expect(postfetch(url, youtubeFetch({ videoStatus: 403, visionUnavailable: true })))
      .rejects.toThrow("YouTube stream failed: 403; visionOS HLS: Sign in required");
  });

  test("rejects a fallback without an HLS manifest", async () => {
    await expect(postfetch(url, youtubeFetch({ videoStatus: 403, missingManifest: true })))
      .rejects.toThrow("YouTube HLS manifest not found");
  });

  test("does not return a silent fallback when its audio group is missing", async () => {
    await expect(postfetch(url, youtubeFetch({ videoStatus: 403, manifest: manifest.replaceAll('GROUP-ID="aac"', 'GROUP-ID="other"') })))
      .rejects.toThrow("video with AAC audio not found");
  });

  test("does not treat MPEG-TS segments as fragmented MP4", async () => {
    await expect(postfetch(url, youtubeFetch({ videoStatus: 403, playlist: "#EXTM3U\n#EXTINF:4,\nsegment.ts" })))
      .rejects.toThrow("YouTube HLS video is not fragmented MP4");
  });
});
