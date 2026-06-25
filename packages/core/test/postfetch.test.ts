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
});
