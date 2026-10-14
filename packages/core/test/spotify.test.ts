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
  searches?: Record<string, unknown>[][];
  unavailableVideos?: string[];
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const entity = { id, type: "track", title: "Небо", artists: [{ name: "SadSvit" }], duration: 219847, ...options.entity };
  const spotifyHtml = `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script>`;
  const searchHtml = (candidates: Record<string, unknown>[]) => `<script>${options.assignment ?? "var ytInitialData"} = ${JSON.stringify({
    contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
      { itemSectionRenderer: { contents: candidates.map((videoRenderer) => ({ videoRenderer })) } },
    ] } } } },
  })}; window.otherValue = {};</script>`;
  let searches = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `https://open.spotify.com/embed/track/${id}`) {
      return new Response(options.spotifyHtml ?? spotifyHtml, { status: options.spotifyStatus ?? 200 });
    }
    if (url.startsWith("https://www.youtube.com/results?")) {
      const candidates = options.searches ? options.searches[searches++] ?? [] : options.candidates ?? [candidate()];
      return new Response(options.searchHtml ?? searchHtml(candidates), { status: options.searchStatus ?? 200 });
    }
    if (url.startsWith("https://www.youtube.com/watch?")) {
      return new Response('"visitorData":"visitor","jsUrl":"/s/player/test/base.js"');
    }
    if (url.includes("/s/player/")) return new Response("signatureTimestamp:20000");
    if (url.includes("/youtubei/v1/player")) {
      const body = JSON.parse(String(init?.body));
      if (options.unavailableVideos?.includes(body.videoId)) {
        return Response.json({ playabilityStatus: { status: "UNPLAYABLE", reason: "This video is not available" } });
      }
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
    expect(stub.calls.filter(({ url }) => url.includes("/results?")).length).toBe(1);
  });

  test("tries another query when the first search has no match", async () => {
    const stub = fixture({ searches: [[], [candidate()]] });
    const result = await postfetch(spotifyUrl, stub);
    expect(result.items[0].id).toBe(videoId);
    const queries = stub.calls.filter(({ url }) => url.includes("/results?")).map(({ url }) => new URL(url).searchParams.get("search_query"));
    expect(queries).toEqual(["SadSvit Небо audio", 'SadSvit "Небо"']);
  });

  test("tries the next matched upload when the preferred upload is unavailable", async () => {
    const otherId = "Jj9RSrfs4tY";
    const stub = fixture({ candidates: [candidate(), candidate({ videoId: otherId })], unavailableVideos: [videoId] });
    const result = await postfetch(spotifyUrl, stub);
    expect(result.items[0].id).toBe(otherId);
    expect(stub.calls.filter(({ url }) => url.includes("/results?")).length).toBe(1);
    expect(stub.calls.filter(({ url }) => url.includes("/watch?")).map(({ url }) => new URL(url).searchParams.get("v"))).toEqual([videoId, otherId]);
  });

  test("deduplicates unavailable uploads across queries and caps original resolution attempts at three", async () => {
    const ids = [videoId, "Jj9RSrfs4tY", "cPzhNzqt9LB", "cPzhNzqt9LC"];
    const stub = fixture({ candidates: ids.map((videoId) => candidate({ videoId })), unavailableVideos: ids });
    await expect(postfetch(spotifyUrl, stub)).rejects.toThrow("This video is not available");
    expect(stub.calls.filter(({ url }) => url.includes("/watch?")).map(({ url }) => new URL(url).searchParams.get("v"))).toEqual(ids.slice(0, 3));
    expect(stub.calls.filter(({ url }) => url.includes("/results?")).length).toBe(4);
  });

  const liveId = "DuboSByuoNA";
  const liveVideo = candidate({ videoId: liveId, title: { simpleText: "SadSvit - Небо (Live)" } });

  test("searches for original recordings before choosing a live result from an earlier query", async () => {
    const stub = fixture({ searches: [[liveVideo], [], [candidate()]] });
    const result = await postfetch(spotifyUrl, stub);
    expect(result.items[0].id).toBe(videoId);
    expect(result.metadata?.extra).not.toHaveProperty("youtubeLiveFallback");
    expect(stub.calls.filter(({ url }) => url.includes("/watch?")).length).toBe(1);
  });

  test("uses a live performance only after original searches and resolution fail", async () => {
    const stub = fixture({ candidates: [candidate(), liveVideo], unavailableVideos: [videoId] });
    const result = await postfetch(spotifyUrl, stub);
    expect(result.items[0].id).toBe(liveId);
    expect(result.metadata?.extra).toMatchObject({ youtubeUrl: `https://www.youtube.com/watch?v=${liveId}`, youtubeLiveFallback: true });
    expect(stub.calls.filter(({ url }) => url.includes("/results?")).length).toBe(4);
    expect(stub.calls.filter(({ url }) => url.includes("/watch?")).map(({ url }) => new URL(url).searchParams.get("v"))).toEqual([videoId, liveId]);
  });

  test("finds Moonpills by its joined title and matches the long Chkbns abbreviation", async () => {
    const stub = fixture({
      entity: { title: "Moon Pills", artists: [{ name: "Chkbns" }], duration: 267847 },
      searches: [[], [], [], [candidate({ videoId: liveId, title: { simpleText: "Cheekbones - Moonpills (Live at Oxygen Studio)" }, ownerText: { simpleText: "Oxygen Studio" }, lengthText: { simpleText: "4:17" } })]],
    });
    const result = await postfetch(spotifyUrl, stub);
    expect(result.metadata?.extra).toMatchObject({ youtubeUrl: `https://www.youtube.com/watch?v=${liveId}`, youtubeLiveFallback: true });
    const queries = stub.calls.filter(({ url }) => url.includes("/results?")).map(({ url }) => new URL(url).searchParams.get("search_query"));
    expect(queries).toEqual(['Chkbns Moon Pills audio', 'Chkbns "Moon Pills"', 'Moon Pills', 'Chkbns MoonPills']);
  });

  for (const [label, override] of Object.entries({
    "another artist": { title: { simpleText: "Other Band - Moonpills (Live)" } },
    "another song": { title: { simpleText: "Cheekbones - Moonpill (Live)" } },
    "cover": { title: { simpleText: "Cheekbones - Moonpills (Live cover)" } },
    "speed edit": { title: { simpleText: "Cheekbones - Moonpills (Live sped up)" } },
    "wrong duration": { lengthText: { simpleText: "10:00" } },
  })) {
    test(`rejects a live fallback with ${label}`, async () => {
      const stub = fixture({
        entity: { title: "Moon Pills", artists: [{ name: "Chkbns" }], duration: 267847 },
        candidates: [candidate({ title: { simpleText: "Cheekbones - Moonpills (Live)" }, ownerText: { simpleText: "Oxygen Studio" }, lengthText: { simpleText: "4:17" }, ...override })],
      });
      await expect(postfetch(spotifyUrl, stub)).rejects.toMatchObject({ reason: "noMatch" });
      expect(stub.calls.some(({ url }) => url.includes("/watch?"))).toBe(false);
    });
  }

  test("does not expand short artist acronyms", async () => {
    await expect(postfetch(spotifyUrl, fixture({
      entity: { artists: [{ name: "Scvt" }] },
      candidates: [candidate({ title: { simpleText: "Небо" }, ownerText: { simpleText: "Sacovita - Topic" } })],
    }))).rejects.toMatchObject({ reason: "noMatch" });
  });

  test("caps live resolution attempts at two and keeps playback errors", async () => {
    const ids = [liveId, "Jj9RSrfs4tY", "cPzhNzqt9LC"];
    const stub = fixture({ candidates: ids.map((videoId) => ({ ...liveVideo, videoId })), unavailableVideos: ids });
    await expect(postfetch(spotifyUrl, stub)).rejects.toThrow("This video is not available");
    expect(stub.calls.filter(({ url }) => url.includes("/watch?")).map(({ url }) => new URL(url).searchParams.get("v"))).toEqual(ids.slice(0, 2));
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

  test("accepts one adjacent-letter typo in a long artist name on a Topic channel", async () => {
    const result = await postfetch(spotifyUrl, fixture({
      entity: { title: "Долгая счастливая жизнь", artists: [{ name: "Grazhdanskaya Oborona" }], duration: 325402 },
      candidates: [candidate({ title: { simpleText: "Долгая счастливая жизнь" }, ownerText: { simpleText: "Grahzdanskaya Oborona - Topic" }, lengthText: { simpleText: "5:26" } })],
    }));
    expect(result.items[0].id).toBe(videoId);
  });

  for (const [label, artist, author] of [
    ["ordinary uploader", "Grazhdanskaya Oborona", "Grahzdanskaya Oborona"],
    ["short artist name", "Live", "Lvie - Topic"],
    ["two transpositions", "Grazhdanskaya Oborona", "Grahzdanskaya Oboorna - Topic"],
    ["different second name", "Grazhdanskaya Oborona", "Grahzdanskaya Orchestra - Topic"],
    ["extra artist name", "Grazhdanskaya Oborona", "Grahzdanskaya Oborona Covers - Topic"],
  ]) {
    test(`keeps artist matching strict for a ${label}`, async () => {
      await expect(postfetch(spotifyUrl, fixture({
        entity: { artists: [{ name: artist }] },
        candidates: [candidate({ title: { simpleText: "Небо" }, ownerText: { simpleText: author } })],
      }))).rejects.toMatchObject({ reason: "noMatch" });
    });
  }

  const colorsTrack = {
    title: "Clair Obscur: Expedition 33 - Alicia - A COLORS SHOW",
    artists: [{ name: "Alice Duport-Percier" }, { name: "Lorien Testard" }, { name: "COLORS" }],
    duration: 169832,
  };
  const colorsVideo = {
    title: { simpleText: "Alice Duport-Percier x Lorien Testard - Alicia | A COLORS SHOW" },
    ownerText: { simpleText: "COLORS" }, lengthText: { simpleText: "2:50" },
  };

  test("matches soundtrack context omitted from a fully credited song and show title", async () => {
    const result = await postfetch(spotifyUrl, fixture({ entity: colorsTrack, candidates: [candidate(colorsVideo)] }));
    expect(result.items[0].id).toBe(videoId);
  });

  for (const [label, overrides] of Object.entries({
    "missing artist": { title: { simpleText: "Alice Duport-Percier - Alicia | A COLORS SHOW" } },
    "different song": { title: { simpleText: "Alice Duport-Percier x Lorien Testard - Aline | A COLORS SHOW" } },
    "different show": { title: { simpleText: "Alice Duport-Percier x Lorien Testard - Alicia | OTHER SHOW" } },
    "different recording": { title: { simpleText: "Alice Duport-Percier x Lorien Testard - Alicia | A COLORS SHOW (cover)" } },
    "different duration": { lengthText: { simpleText: "4:00" } },
  })) {
    test(`rejects a shortened soundtrack title with a ${label}`, async () => {
      await expect(postfetch(spotifyUrl, fixture({ entity: colorsTrack, candidates: [candidate({ ...colorsVideo, ...overrides })] })))
        .rejects.toMatchObject({ reason: "noMatch" });
    });
  }

  test("does not shorten ordinary segmented song titles", async () => {
    await expect(postfetch(spotifyUrl, fixture({
      entity: { ...colorsTrack, title: "Another Song - Alicia - A COLORS SHOW" },
      candidates: [candidate(colorsVideo)],
    }))).rejects.toMatchObject({ reason: "noMatch" });
  });

  test("parses YouTube's JSON script search payload", async () => {
    const searchHtml = `<script id="yt-initial-data" type="application/json">${JSON.stringify({
      contents: { itemSectionRenderer: { contents: [{ videoRenderer: candidate() }] } },
    })}</script><script>window['ytInitialData'] = JSON.parse(document.getElementById('yt-initial-data').textContent);</script>`;
    const result = await postfetch(spotifyUrl, fixture({ searchHtml }));
    expect(result.items[0].id).toBe(videoId);
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
      await expect(postfetch(spotifyUrl, stub)).rejects.toMatchObject({ status: 404, reason: "noMatch" });
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
    await expect(postfetch(spotifyUrl, fixture({ candidates: [] }))).rejects.toMatchObject({ status: 404, reason: "noMatch" });
  });
});
