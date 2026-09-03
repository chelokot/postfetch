import { describe, expect, test } from "bun:test";
import { detect, postfetch, PostfetchError } from "../src/index";

function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    return routes[match]();
  }) as typeof fetch;
}

describe("detect", () => {
  test("maps hosts to platforms", () => {
    expect(detect("https://www.instagram.com/reel/ABC/")).toBe("instagram");
    expect(detect("https://www.linkedin.com/posts/example-activity-123-test")).toBe("linkedin");
    expect(detect("https://uk.linkedin.com/feed/update/urn:li:activity:123")).toBe("linkedin");
    expect(detect("https://vt.tiktok.com/ZSxpHvCUM/")).toBe("tiktok");
    expect(detect("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detect("https://www.facebook.com/share/v/ABC/")).toBe("facebook");
    expect(detect("https://x.com/i/status/123")).toBe("twitter");
    expect(detect("https://www.reddit.com/r/aww/comments/abc/title/")).toBe("reddit");
    expect(detect("https://redd.it/abc")).toBe("reddit");
    expect(detect("https://www.pinterest.com/pin/12345/")).toBe("pinterest");
    expect(detect("https://pin.it/abcdef")).toBe("pinterest");
    expect(detect("https://soundcloud.com/artist/track")).toBe("soundcloud");
    expect(detect("https://on.soundcloud.com/abc")).toBe("soundcloud");
  });

  test("rejects unsupported hosts", () => {
    expect(() => detect("https://example.com/x")).toThrow(PostfetchError);
    expect(() => detect("https://lnkd.in/abc")).toThrow(PostfetchError);
  });
});

describe("postfetch", () => {
  test("rejects an empty url", async () => {
    await expect(postfetch("   ")).rejects.toThrow(PostfetchError);
  });

  test("rejects an invalid tryMaxBytes value", async () => {
    await expect(postfetch("https://www.facebook.com/reel/123", { tryMaxBytes: 0 })).rejects.toMatchObject({ status: 400 });
  });

  test("resolves an Instagram reel from the inline page (injected fetch)", async () => {
    const html = `<html><body><script type="application/json">${JSON.stringify({
      require: [{ media: { code: "DZ0", media_type: 2, video_versions: [{ type: 101, url: "https://cdn.test/reel.mp4" }] } }],
    })}</script></body></html>`;
    const result = await postfetch("https://www.instagram.com/reel/DZ0/", {
      fetch: stubFetch({ "https://www.instagram.com/p/DZ0/": () => new Response(html) }),
    });

    expect(result.platform).toBe("instagram");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "video", mime: "video/mp4", url: "https://cdn.test/reel.mp4" });
  });

  test("resolves an X video tweet via syndication and picks the highest bitrate (injected fetch)", async () => {
    const tweet = {
      __typename: "Tweet",
      mediaDetails: [
        {
          type: "video",
          video_info: {
            variants: [
              { bitrate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/lo.mp4" },
              { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/hi.mp4" },
              { content_type: "application/x-mpegURL", url: "https://video.twimg.com/stream.m3u8" },
            ],
          },
        },
      ],
    };
    const result = await postfetch("https://x.com/i/status/123", {
      fetch: stubFetch({
        "https://cdn.syndication.twimg.com/tweet-result": () =>
          new Response(JSON.stringify(tweet), { headers: { "content-type": "application/json" } }),
      }),
    });

    expect(result.platform).toBe("twitter");
    expect(result.items[0]).toMatchObject({ kind: "video", url: "https://video.twimg.com/hi.mp4" });
  });

  test("includes media and metadata from an embedded quoted X post", async () => {
    const video = (url: string) => ({
      type: "video",
      video_info: { variants: [{ bitrate: 2176000, content_type: "video/mp4", url }] },
    });
    const tweet = {
      __typename: "Tweet",
      id_str: "100",
      text: "Outer text",
      user: { name: "Outer", screen_name: "outer" },
      mediaDetails: [video("https://video.twimg.com/outer.mp4")],
      quoted_tweet: {
        id_str: "90",
        text: "Quoted text",
        lang: "en",
        user: { name: "Quoted", screen_name: "quoted" },
        mediaDetails: [video("https://video.twimg.com/quoted.mp4")],
      },
    };
    const result = await postfetch("https://x.com/outer/status/100/video/1", {
      fetch: stubFetch({
        "https://cdn.syndication.twimg.com/tweet-result": () =>
          new Response(JSON.stringify(tweet), { headers: { "content-type": "application/json" } }),
      }),
    });
    if (result.platform !== "twitter") {
      throw new Error("expected a twitter result");
    }

    expect(result.items).toEqual([
      expect.objectContaining({ filename: "twitter_100_1.mp4", id: "100", url: "https://video.twimg.com/outer.mp4" }),
      expect.objectContaining({ filename: "twitter_90_1.mp4", id: "90", url: "https://video.twimg.com/quoted.mp4" }),
    ]);
    expect(result.metadata?.text).toBe("Outer text");
    expect(result.metadata?.extra?.quotedTweet).toEqual({
      id: "90",
      metadata: expect.objectContaining({
        text: "Quoted text",
        author: expect.objectContaining({ handle: "quoted", name: "Quoted" }),
        extra: { lang: "en" },
      }),
    });
  });

  test("resolves a Facebook share link through the embed player (injected fetch)", async () => {
    const canonical = "https://www.facebook.com/reel/123456";
    const embed = `<html>{"hd_src":"https:\\/\\/cdn.test\\/fb.mp4","sd_src":"https:\\/\\/cdn.test\\/fb-sd.mp4"}</html>`;
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const result = await postfetch("https://www.facebook.com/share/v/ABC/", {
      fetch: stubFetch({
        "https://www.facebook.com/share/v/ABC/": () => redirected(canonical),
        "https://www.facebook.com/plugins/video.php": () => new Response(embed),
      }),
    });

    expect(result.platform).toBe("facebook");
    expect(result.items[0]).toMatchObject({ kind: "video", id: "123456", url: "https://cdn.test/fb.mp4" });
  });

  test("normalizes a suffixed Facebook share link and honors a low preferred width", async () => {
    const requested: string[] = [];
    const validShare = "https://www.facebook.com/share/r/19DLkVRYDA/";
    const canonical = "https://www.facebook.com/reel/1708489969798741";
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url === validShare) {
        return redirected(canonical);
      }
      if (url.startsWith("https://www.facebook.com/plugins/video.php")) {
        return new Response('<html>{"hd_src":"https:\\/\\/cdn.test\\/fb-hd.mp4","sd_src":"https:\\/\\/cdn.test\\/fb-sd.mp4"}</html>');
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch(`${validShare}%D1%84%D0%B8%D0%B3%D0%B0%D1%81%D1%81%D0%B5`, {
      fetch,
      preferredWidth: 360,
    });

    expect(requested[0]).toBe(validShare);
    expect(result.items[0]).toMatchObject({ id: "1708489969798741", url: "https://cdn.test/fb-sd.mp4" });
  });

  test("honors a low preferred width for the Facebook watch-page fallback", async () => {
    const canonical = "https://www.facebook.com/reel/123456";
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === canonical) {
        return redirected(canonical);
      }
      if (url.startsWith("https://www.facebook.com/plugins/video.php")) {
        return new Response("<html></html>");
      }
      if (url.startsWith("https://www.facebook.com/watch/")) {
        return new Response(
          '<html>{"playable_url_quality_hd":"https:\\/\\/cdn.test\\/watch-hd.mp4","playable_url":"https:\\/\\/cdn.test\\/watch-sd.mp4"}</html>',
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch(canonical, { fetch, preferredWidth: 360 });

    expect(result.items[0]).toMatchObject({ id: "123456", url: "https://cdn.test/watch-sd.mp4" });
  });

  test("tryMaxBytes returns a smaller Facebook rendition when the normal one is too large", async () => {
    const share = "https://www.facebook.com/share/r/ABC/";
    const canonical = "https://www.facebook.com/reel/123456";
    const headRequests: string[] = [];
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "HEAD") {
        headRequests.push(url);
        const bytes = url.endsWith("fb-hd.mp4") ? 60_000_000 : 40_000_000;
        return new Response(null, { headers: { "content-length": String(bytes) } });
      }
      if (url === share) {
        return redirected(canonical);
      }
      if (url.startsWith("https://www.facebook.com/plugins/video.php")) {
        return new Response('<html>{"hd_src":"https:\\/\\/cdn.test\\/fb-hd.mp4","sd_src":"https:\\/\\/cdn.test\\/fb-sd.mp4"}</html>');
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch(share, { fetch, tryMaxBytes: 50_000_000 });

    expect(result.items[0]?.url).toBe("https://cdn.test/fb-sd.mp4");
    expect(headRequests).toEqual(["https://cdn.test/fb-hd.mp4", "https://cdn.test/fb-sd.mp4"]);
  });

  test("tryMaxBytes keeps the normal rendition when its size cannot be discovered", async () => {
    const canonical = "https://www.facebook.com/reel/123456";
    let embedRequests = 0;
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "HEAD") {
        return new Response(null, { status: 405 });
      }
      if (url === canonical) {
        return redirected(canonical);
      }
      if (url.startsWith("https://www.facebook.com/plugins/video.php")) {
        embedRequests += 1;
        return new Response('<html>{"hd_src":"https:\\/\\/cdn.test\\/fb-hd.mp4","sd_src":"https:\\/\\/cdn.test\\/fb-sd.mp4"}</html>');
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch(canonical, { fetch, tryMaxBytes: 50_000_000 });

    expect(result.items[0]?.url).toBe("https://cdn.test/fb-hd.mp4");
    expect(embedRequests).toBe(1);
  });

  test("reports a missing Facebook video as a typed not-found error", async () => {
    const redirected = (target: string): Response => {
      const response = new Response("");
      Object.defineProperty(response, "url", { value: target });
      return response;
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://www.facebook.com/reel/123456") {
        return redirected(url);
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      await postfetch("https://www.facebook.com/reel/123456", { fetch });
      throw new Error("expected postfetch to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PostfetchError);
      expect(error).toMatchObject({ reason: "notFound", status: 404 });
    }
  });

  test("resolves a YouTube video through the session bootstrap (injected fetch)", async () => {
    const watch = `<html>"visitorData":"VD123","jsUrl":"/s/player/abc/base.js"</html>`;
    const playerJs = "var meta={signatureTimestamp:20123};";
    const player = {
      playabilityStatus: { status: "OK" },
      streamingData: { formats: [{ url: "https://cdn.test/yt.mp4", mimeType: "video/mp4; codecs=avc1", height: 720 }] },
      videoDetails: { title: "Never Gonna" },
    };
    const result = await postfetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      fetch: stubFetch({
        "https://www.youtube.com/watch": () => new Response(watch),
        "https://www.youtube.com/s/player/": () => new Response(playerJs),
        "https://www.youtube.com/youtubei/v1/player": () =>
          new Response(JSON.stringify(player), { headers: { "content-type": "application/json" } }),
      }),
    });

    expect(result.platform).toBe("youtube");
    expect(result.items[0]).toMatchObject({ kind: "video", url: "https://cdn.test/yt.mp4" });
  });

  test("resolves a YouTube video to a muxed adaptive H.264 + AAC pair (injected fetch)", async () => {
    const watch = `<html>"visitorData":"VD123","jsUrl":"/s/player/abc/base.js"</html>`;
    const playerJs = "var meta={signatureTimestamp:20123};";
    const player = {
      playabilityStatus: { status: "OK" },
      streamingData: {
        formats: [{ url: "https://cdn.test/yt360.mp4", mimeType: "video/mp4; codecs=avc1", height: 360 }],
        adaptiveFormats: [
          { url: "https://cdn.test/v480.mp4", mimeType: 'video/mp4; codecs="avc1.4d401f"', width: 854, height: 480 },
          { url: "https://cdn.test/v1080.mp4", mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
          { url: "https://cdn.test/v2160.webm", mimeType: 'video/webm; codecs="vp9"', width: 3840, height: 2160 },
          { url: "https://cdn.test/a128.m4a", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
          { url: "https://cdn.test/a256.m4a", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 256000 },
        ],
      },
      videoDetails: { title: "Clip" },
    };
    const result = await postfetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      preferredWidth: 1920,
      fetch: stubFetch({
        "https://www.youtube.com/watch": () => new Response(watch),
        "https://www.youtube.com/s/player/": () => new Response(playerJs),
        "https://www.youtube.com/youtubei/v1/player": () =>
          new Response(JSON.stringify(player), { headers: { "content-type": "application/json" } }),
      }),
    });

    expect(result.items[0]).toMatchObject({
      kind: "video",
      url: "https://cdn.test/v1080.mp4",
      audio: { url: "https://cdn.test/a256.m4a" },
    });
  });

  function redditRoutes(post: object): Record<string, () => Response> {
    return {
      "https://www.reddit.com/api/v1/access_token": () =>
        new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } }),
      "https://oauth.reddit.com/comments/": () =>
        new Response(JSON.stringify([{ data: { children: [{ data: post }] } }]), {
          headers: { "content-type": "application/json" },
        }),
    };
  }

  test("resolves a Reddit gallery into ordered images (injected fetch)", async () => {
    const post = {
      id: "g1",
      is_gallery: true,
      gallery_data: { items: [{ media_id: "m1" }, { media_id: "m2" }] },
      media_metadata: {
        m1: { status: "valid", m: "image/jpg", s: { u: "https://preview.redd.it/m1.jpg?s=a" } },
        m2: { status: "valid", m: "image/png", s: { u: "https://preview.redd.it/m2.png?s=b" } },
      },
    };
    const result = await postfetch("https://www.reddit.com/r/aww/comments/g1/title/", {
      fetch: stubFetch(redditRoutes(post)),
    });

    expect(result.platform).toBe("reddit");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ kind: "image", mime: "image/jpeg", url: "https://preview.redd.it/m1.jpg?s=a" });
    expect(result.items[1]).toMatchObject({ kind: "image", mime: "image/png", url: "https://preview.redd.it/m2.png?s=b" });
  });

  test("resolves a silent Reddit video to its fallback stream (injected fetch)", async () => {
    const post = {
      id: "v1",
      is_video: true,
      secure_media: { reddit_video: { fallback_url: "https://v.redd.it/v1/DASH_480.mp4", has_audio: false } },
    };
    const result = await postfetch("https://www.reddit.com/r/x/comments/v1/clip/", {
      fetch: stubFetch(redditRoutes(post)),
    });

    expect(result.items[0]).toMatchObject({ kind: "video", mime: "video/mp4", url: "https://v.redd.it/v1/DASH_480.mp4" });
  });

  test("resolves a Reddit video with audio to a muxed item (injected fetch)", async () => {
    const post = {
      id: "v2",
      is_video: true,
      secure_media: {
        reddit_video: {
          fallback_url: "https://v.redd.it/v2/DASH_480.mp4?source=fallback",
          has_audio: true,
          dash_url: "https://v.redd.it/v2/DASHPlaylist.mpd?a=TOKEN",
        },
      },
    };
    const manifest = `<MPD><Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Representation width="480" height="854" bandwidth="1298799"><BaseURL>DASH_480.mp4</BaseURL></Representation>
        <Representation width="1280" height="720" bandwidth="2484740"><BaseURL>DASH_720.mp4</BaseURL></Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation bandwidth="134352"><BaseURL>DASH_AUDIO_128.mp4</BaseURL></Representation>
      </AdaptationSet>
    </Period></MPD>`;
    const routes = {
      ...redditRoutes(post),
      "https://v.redd.it/v2/DASHPlaylist.mpd": () => new Response(manifest),
    };
    const result = await postfetch("https://www.reddit.com/r/x/comments/v2/clip/", { fetch: stubFetch(routes) });

    expect(result.items[0]).toMatchObject({
      kind: "video",
      mime: "video/mp4",
      url: "https://v.redd.it/v2/DASH_480.mp4?a=TOKEN",
      audio: { url: "https://v.redd.it/v2/DASH_AUDIO_128.mp4?a=TOKEN" },
    });
  });

  function pinterestRoutes(pin: object): Record<string, () => Response> {
    return {
      "https://www.pinterest.com/resource/PinResource/get/": () =>
        new Response(JSON.stringify({ resource_response: { data: pin } }), {
          headers: { "content-type": "application/json" },
        }),
    };
  }

  test("resolves a Pinterest video pin to its progressive mp4 (injected fetch)", async () => {
    const pin = {
      id: "123",
      videos: {
        video_list: {
          V_720P: { url: "https://v1.pinimg.com/videos/x/720p/a.mp4", width: 720, height: 1280 },
          V_HLSV4: { url: "https://v1.pinimg.com/videos/x/hls/a.m3u8", width: 720, height: 1280 },
        },
      },
    };
    const result = await postfetch("https://www.pinterest.com/pin/123/", { fetch: stubFetch(pinterestRoutes(pin)) });

    expect(result.platform).toBe("pinterest");
    expect(result.items[0]).toMatchObject({ kind: "video", mime: "video/mp4", url: "https://v1.pinimg.com/videos/x/720p/a.mp4" });
  });

  test("resolves a Pinterest image pin to its original (injected fetch)", async () => {
    const pin = { id: "456", images: { orig: { url: "https://i.pinimg.com/originals/aa/bb.jpg", width: 480, height: 360 } } };
    const result = await postfetch("https://www.pinterest.com/pin/456/", { fetch: stubFetch(pinterestRoutes(pin)) });

    expect(result.items[0]).toMatchObject({ kind: "image", mime: "image/jpeg", url: "https://i.pinimg.com/originals/aa/bb.jpg" });
  });

  test("resolves a Pinterest idea pin through its HLS master (injected fetch)", async () => {
    const pin = {
      id: "789",
      images: { orig: { url: "https://i.pinimg.com/originals/cover.jpg" } },
      story_pin_data: {
        pages: [{ blocks: [{ block_type: 3, video: { video_list: { V_HLSV3_MOBILE: { url: "https://v1.pinimg.com/videos/x/hls/b.m3u8" } } } }] }],
      },
    };
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",URI="b_audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=378552,RESOLUTION=234x416,AUDIO="audio1"',
      "b_240w.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=896408,RESOLUTION=486x864,AUDIO="audio1"',
      "b_486w.m3u8",
    ].join("\n");
    const routes = { ...pinterestRoutes(pin), "https://v1.pinimg.com/videos/x/hls/b.m3u8": () => new Response(master) };
    const result = await postfetch("https://www.pinterest.com/pin/789/", { preferredWidth: 480, fetch: stubFetch(routes) });

    expect(result.items[0]).toMatchObject({
      kind: "video",
      hls: true,
      url: "https://v1.pinimg.com/videos/x/hls/b_486w.m3u8",
      audio: { url: "https://v1.pinimg.com/videos/x/hls/b_audio.m3u8" },
    });
  });

  function soundcloudRoutes(transcodings: unknown[]): Record<string, () => Response> {
    const json = (body: unknown) => () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    return {
      "https://soundcloud.com/": () =>
        new Response(`<script crossorigin src="https://a-v2.sndcdn.com/assets/app-9.js"></script>`),
      "https://a-v2.sndcdn.com/assets/": () => new Response(`var o={client_id:"ABCDEFGHIJKLMNOPQRSTUV"};`),
      "https://api-v2.soundcloud.com/resolve": json({ kind: "track", id: 123, title: "Test Track", media: { transcodings } }),
      "https://api-v2.soundcloud.com/media/": json({ url: "https://cf-media.sndcdn.com/x.128.mp3?Policy=y" }),
    };
  }

  test("resolves a SoundCloud track to its progressive mp3 (injected fetch)", async () => {
    const result = await postfetch("https://soundcloud.com/artist/track", {
      fetch: stubFetch(
        soundcloudRoutes([
          { format: { protocol: "hls", mime_type: "audio/mpeg" }, url: "https://api-v2.soundcloud.com/media/t/h/stream/hls" },
          { format: { protocol: "progressive", mime_type: "audio/mpeg" }, url: "https://api-v2.soundcloud.com/media/t/p/stream/progressive" },
        ]),
      ),
    });

    expect(result.platform).toBe("soundcloud");
    expect(result.id).toBe("123");
    expect(result.items[0]).toMatchObject({ kind: "audio", mime: "audio/mpeg", url: "https://cf-media.sndcdn.com/x.128.mp3?Policy=y" });
  });

  test("resolves a SoundCloud HLS-only track as an assembled audio item (injected fetch)", async () => {
    const result = await postfetch("https://soundcloud.com/artist/track", {
      fetch: stubFetch(
        soundcloudRoutes([
          { format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, url: "https://api-v2.soundcloud.com/media/t/h/stream/hls" },
        ]),
      ),
    });

    expect(result.items[0]).toMatchObject({
      kind: "audio",
      mime: "audio/mp4",
      hls: true,
      url: "https://cf-media.sndcdn.com/x.128.mp3?Policy=y",
    });
  });
});
