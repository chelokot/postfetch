import { describe, expect, test } from "bun:test";
import { detect, postfetch, toResponse } from "../src/index";

const id = "2qGURS7y8zM7STkxOLgnWO";
const spotifyUrl = `https://open.spotify.com/track/${id}?si=tracking&utm_source=copy-link`;
const videoId = "cPzhNzqt9LA";
const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    videoId,
    title: { runs: [{ text: "SadSvit - Небо (Official video)" }] },
    ownerText: { runs: [{ text: "SadSvit" }] },
    lengthText: { simpleText: "3:46" },
    ...overrides,
  };
}

function fixture(options: {
  entity?: Record<string, unknown>;
  candidates?: Record<string, unknown>[];
  spotifyHtml?: string;
  searchHtml?: string;
  spotifyStatus?: number;
  searchStatus?: number;
  fallback?: boolean;
  assignment?: string;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const entity = { id, type: "track", title: "Небо", artists: [{ name: "SadSvit" }], duration: 219847, ...options.entity };
  const spotifyHtml = `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script>`;
  const searchHtml = `<script>${options.assignment ?? "var ytInitialData"} = ${JSON.stringify({
    contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
      { itemSectionRenderer: { contents: (options.candidates ?? [candidate()]).map((videoRenderer) => ({ videoRenderer })) } },
    ] } } } },
  })}; window.otherValue = {};</script>`;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `https://open.spotify.com/embed/track/${id}`) {
      return new Response(options.spotifyHtml ?? spotifyHtml, { status: options.spotifyStatus ?? 200 });
    }
    if (url.startsWith("https://www.youtube.com/results?")) {
      return new Response(options.searchHtml ?? searchHtml, { status: options.searchStatus ?? 200 });
    }
    if (url.startsWith("https://www.youtube.com/watch?")) {
      return new Response('"visitorData":"visitor","jsUrl":"/s/player/test/base.js"');
    }
    if (url.includes("/s/player/")) return new Response("signatureTimestamp:20000");
    if (url.includes("/youtubei/v1/player")) {
      const body = JSON.parse(String(init?.body));
      if (options.fallback && body.context.client.clientName === "ANDROID_VR") {
        return Response.json({ playabilityStatus: { status: "ERROR" } });
      }
      return Response.json({
        playabilityStatus: { status: "OK" },
        videoDetails: { title: "YouTube video title", author: "YouTube uploader", lengthSeconds: "226" },
        streamingData: options.fallback ? { hlsManifestUrl: "https://cdn.test/master.m3u8" } : { adaptiveFormats: [
          { url: "https://cdn.test/video.mp4", mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 720 },
          { url: "https://cdn.test/small.mp4", mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 360 },
          { url: "https://cdn.test/audio.m4a", mimeType: "audio/mp4", bitrate: 128000 },
        ] },
      });
    }
    if (url === "https://cdn.test/master.m3u8") return new Response([
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Original",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1700000,CODECS="vp09.00.31.08,mp4a.40.2",RESOLUTION=720x1280,AUDIO="aac"',
      "video.m3u8",
    ].join("\n"));
    if (url.endsWith(".m3u8")) return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment.m4s');
    if (url.startsWith("https://cdn.test/")) return new Response("media", {
      headers: { "content-type": "video/mp4", "content-length": url.endsWith("/video.mp4") ? "1000" : "5" },
    });
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Spotify YouTube matching", () => {
  test("resolves track links to existing YouTube video + audio and exposes the watch URL", async () => {
    const stub = fixture();
    const result = await postfetch(spotifyUrl, { fetch: stub.fetch, preferredWidth: 360 });
    expect(result).toMatchObject({
      platform: "spotify", id, comments: [],
      metadata: { title: "Небо", author: { name: "SadSvit" }, extra: { youtubeUrl, artists: ["SadSvit"], durationSeconds: 219.847 } },
      items: [{ id: videoId, platform: "youtube", kind: "video", mime: "video/mp4", url: "https://cdn.test/small.mp4", audio: { url: "https://cdn.test/audio.m4a" } }],
    });
    const search = new URL(stub.calls.find(({ url }) => url.includes("/results?"))!.url);
    expect(search.searchParams.get("search_query")).toBe("SadSvit Небо audio");
    const player = stub.calls.find(({ url }) => url.includes("/youtubei/v1/player"));
    expect(JSON.parse(String(player?.init?.body)).videoId).toBe(videoId);
    expect(result.items[0].filename).toEndWith(".mp4");
  });

  test("preserves the YouTube HLS fallback", async () => {
    const result = await postfetch(spotifyUrl, fixture({ fallback: true }));
    expect(result.items[0]).toMatchObject({ platform: "youtube", kind: "video", hls: true, url: "https://cdn.test/video.m3u8", audio: { url: "https://cdn.test/audio.m3u8" } });
  });

  test("prefers an artist upload over a closer-duration unofficial lyric video", async () => {
    const result = await postfetch(spotifyUrl, fixture({ candidates: [
      candidate({ videoId: "Jj9RSrfs4tY", title: { simpleText: "SadSvit Небо Lyrics" }, ownerText: { simpleText: "Lyrics channel" }, lengthText: { simpleText: "3:40" } }),
      candidate(),
    ] }));
    if (result.platform !== "spotify") throw new Error("Expected Spotify");
    expect(result.metadata?.extra?.youtubeUrl).toBe(youtubeUrl);
  });

  for (const [label, invalid] of Object.entries({
    "wrong title": { title: { simpleText: "SadSvit - Касета" } },
    "wrong artist": { title: { simpleText: "Other artist - Небо" }, ownerText: { simpleText: "Other artist" } },
    "wrong duration": { lengthText: { simpleText: "10:00" } },
    "live stream": { lengthText: undefined },
    "cover": { title: { simpleText: "SadSvit - Небо (cover)" } },
    "remix": { title: { simpleText: "SadSvit - Небо remix" } },
    "speed edit": { title: { simpleText: "SadSvit - Небо (sped up)" } },
    "invalid video id": { videoId: "invalid/id?" },
  })) {
    test(`rejects a ${label} instead of taking the first search result`, async () => {
      const stub = fixture({ candidates: [candidate(invalid)] });
      await expect(postfetch(spotifyUrl, stub)).rejects.toMatchObject({ status: 404, reason: "notFound" });
      expect(stub.calls.some(({ url }) => url.includes("/watch?"))).toBe(false);
    });
  }

  test("allows the requested recording version", async () => {
    const result = await postfetch(spotifyUrl, fixture({
      entity: { title: "Небо (Live)" }, candidates: [candidate({ title: { simpleText: "SadSvit - Небо live" } })],
    }));
    expect(result.items).toHaveLength(1);
  });

  test("normalizes Unicode and ignores feature credits when matching titles", async () => {
    const result = await postfetch(spotifyUrl, fixture({
      entity: { title: "Déjà Vu (feat. Guest)", artists: [{ name: "Beyoncé" }, { name: "Guest" }] },
      candidates: [candidate({ title: { simpleText: "DEJA VU" }, ownerText: { simpleText: "Beyonce - Topic" } })],
    }));
    expect(result.metadata?.author?.name).toBe("Beyoncé, Guest");
  });

  test("parses window assignment and braces, escapes and semicolons inside JSON strings", async () => {
    const title = 'Небо }; "Sky"';
    const result = await postfetch(spotifyUrl, fixture({
      assignment: 'window["ytInitialData"]', entity: { title },
      candidates: [candidate({ title: { simpleText: `SadSvit - ${title}` } })],
    }));
    expect(result.items).toHaveLength(1);
  });

  test("re-resolves smaller media while keeping the selected YouTube URL", async () => {
    const result = await postfetch(spotifyUrl, { ...fixture(), tryMaxBytes: 100 });
    expect(result.items[0].url).toBe("https://cdn.test/small.mp4");
    if (result.platform !== "spotify") throw new Error("Expected Spotify");
    expect(result.metadata?.extra?.youtubeUrl).toBe(youtubeUrl);
  });

  test("includes the matched URL in HTTP output", async () => {
    const stub = fixture();
    const result = await postfetch(spotifyUrl, stub);
    // Use a progressive item here to inspect the streaming response without an
    // unrelated MP4 remux fixture; separate-stream preservation is checked above.
    result.items[0] = { ...result.items[0], audio: undefined };
    const response = await toResponse(result, stub);
    expect(response.headers.get("x-media-youtube-url")).toBe(youtubeUrl);
    expect(response.headers.get("x-media-platform")).toBe("spotify");
    expect(response.headers.get("x-media-id")).toBe(id);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("media");
  });

  test("accepts localized and embed track URLs", async () => {
    for (const path of [`intl-uk/track/${id}`, `embed/track/${id}/`]) {
      expect((await postfetch(`https://open.spotify.com/${path}`, fixture())).platform).toBe("spotify");
    }
  });

  test("rejects non-track and malformed links before fetching", async () => {
    for (const path of [`album/${id}`, `playlist/${id}`, "track/invalid", `track/${id}/extra`]) {
      const stub = fixture();
      await expect(postfetch(`https://open.spotify.com/${path}`, stub)).rejects.toMatchObject({ status: 400 });
      expect(stub.calls).toHaveLength(0);
    }
    expect(detect(spotifyUrl)).toBe("spotify");
    expect(() => detect("https://open.spotify.com.evil.test/track/abc")).toThrow();
  });

  test("reports Spotify lookup and payload failures before searching YouTube", async () => {
    for (const options of [
      { spotifyStatus: 404 }, { spotifyHtml: "no metadata" }, { entity: { artists: [] } }, { entity: { id: "different-track" } },
    ]) {
      const stub = fixture(options);
      await expect(postfetch(spotifyUrl, stub)).rejects.toThrow(/Spotify/);
      expect(stub.calls.some(({ url }) => url.includes("youtube.com"))).toBe(false);
    }
  });

  test("distinguishes search failure from a valid search with no match", async () => {
    await expect(postfetch(spotifyUrl, fixture({ searchStatus: 403 }))).rejects.toMatchObject({ status: 502 });
    await expect(postfetch(spotifyUrl, fixture({ searchHtml: "<html>consent page</html>" }))).rejects.toMatchObject({ status: 502 });
    await expect(postfetch(spotifyUrl, fixture({ candidates: [] }))).rejects.toMatchObject({ status: 404 });
  });
});
