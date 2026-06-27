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
    expect(detect("https://vt.tiktok.com/ZSxpHvCUM/")).toBe("tiktok");
    expect(detect("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detect("https://www.facebook.com/share/v/ABC/")).toBe("facebook");
    expect(detect("https://x.com/i/status/123")).toBe("twitter");
    expect(detect("https://www.reddit.com/r/aww/comments/abc/title/")).toBe("reddit");
    expect(detect("https://redd.it/abc")).toBe("reddit");
  });

  test("rejects unsupported hosts", () => {
    expect(() => detect("https://example.com/x")).toThrow(PostfetchError);
  });
});

describe("postfetch", () => {
  test("rejects an empty url", async () => {
    await expect(postfetch("   ")).rejects.toThrow(PostfetchError);
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

  test("rejects a Reddit video that needs audio muxing (injected fetch)", async () => {
    const post = {
      id: "v2",
      is_video: true,
      secure_media: { reddit_video: { fallback_url: "https://v.redd.it/v2/DASH_480.mp4", has_audio: true } },
    };
    await expect(
      postfetch("https://www.reddit.com/r/x/comments/v2/clip/", { fetch: stubFetch(redditRoutes(post)) }),
    ).rejects.toThrow(/muxing/);
  });
});
