import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";
import { isShortlinkHost } from "../src/tiktok";

describe("tiktok url parsing", () => {
  test("treats vm and vt hosts as shortlinks to follow", () => {
    expect(isShortlinkHost("vm.tiktok.com")).toBe(true);
    expect(isShortlinkHost("vt.tiktok.com")).toBe(true);
  });

  test("leaves canonical hosts untouched", () => {
    expect(isShortlinkHost("www.tiktok.com")).toBe(false);
    expect(isShortlinkHost("m.tiktok.com")).toBe(false);
  });
});

function embedPage(id: string, videoData: object): string {
  const state = {
    source: {
      data: {
        [`/embed/v2/${id}`]: { videoData },
      },
    },
  };
  return `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state)}</script>`;
}

function shellThenEmbed(id: string, videoData: object, requests: Array<{ url: string; userAgent: string | null }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    if (url === `https://www.tiktok.com/@i/video/${id}`) {
      return new Response("<html>generic shell</html>");
    }
    if (url === `https://www.tiktok.com/embed/v2/${id}`) {
      return new Response(embedPage(id, videoData), { headers: { "set-cookie": "ttwid=test; Path=/" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

describe("tiktok page fallbacks", () => {
  test("keeps retrying generic main pages and uses the successful fingerprint for the media", async () => {
    const id = "1122334455";
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    let pageRequests = 0;
    const injectedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
      if (url !== `https://www.tiktok.com/@i/video/${id}`) {
        return new Response("", { status: 404 });
      }
      pageRequests += 1;
      if (pageRequests < 12) {
        return new Response("<html>generic shell</html>");
      }
      const hydration = {
        __DEFAULT_SCOPE__: {
          "webapp.video-detail": {
            itemInfo: {
              itemStruct: {
                id,
                author: { uniqueId: "creator" },
                video: { playAddr: "https://cdn.test/main.mp4" },
              },
            },
          },
        },
      };
      return new Response(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(hydration)}</script>`);
    }) as typeof fetch;

    const result = await postfetch(`https://www.tiktok.com/@creator/video/${id}`, { fetch: injectedFetch });

    expect(pageRequests).toBe(12);
    expect(requests.map(({ userAgent }) => userAgent?.includes("Firefox"))).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(requests.some(({ url }) => url.includes("/embed/v2/"))).toBe(false);
    expect(result.items[0]).toMatchObject({
      kind: "video",
      url: "https://cdn.test/main.mp4",
      headers: { "user-agent": requests[11]?.userAgent },
    });
  });

  test("keeps slideshow images and audio from the embed payload", async () => {
    const id = "987654321";
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const result = await postfetch(`https://www.tiktok.com/@creator/photo/${id}`, {
      fetch: shellThenEmbed(id, {
        itemInfos: {
          id,
          text: "Photo post",
          createTime: "1767225600",
          video: { urls: [], videoMeta: { duration: 0 } },
          diggCount: 1,
          commentCount: 0,
          shareCount: 0,
          playCount: 5,
          locationCreated: "UA",
        },
        authorInfos: { uniqueId: "creator", nickName: "Creator", verified: false },
        musicInfos: { musicName: "Photo sound", authorName: "Artist", playUrl: ["https://cdn.test/audio.mp3?mime_type=audio_mpeg"] },
        imagePostInfo: {
          displayImages: [
            { urlList: ["https://cdn.test/one.jpg"] },
            { urlList: ["https://cdn.test/two.jpg"] },
          ],
        },
      }, requests),
    });

    expect(result.items).toMatchObject([
      { kind: "image", url: "https://cdn.test/one.jpg" },
      { kind: "image", url: "https://cdn.test/two.jpg" },
      { kind: "audio", mime: "audio/mpeg", url: "https://cdn.test/audio.mp3?mime_type=audio_mpeg" },
    ]);
    expect(result.metadata).toMatchObject({
      text: "Photo post",
      author: { handle: "creator", name: "Creator", verified: false },
      createdAt: "2026-01-01T00:00:00.000Z",
      likeCount: 1,
      commentCount: 0,
      shareCount: 0,
      viewCount: 5,
      extra: {
        durationSeconds: 0,
        musicTitle: "Photo sound",
        musicAuthor: "Artist",
        region: "UA",
      },
    });
  });

  test("does not use the embed fallback for video posts", async () => {
    const id = "555555555";
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const result = postfetch(`https://www.tiktok.com/@creator/video/${id}`, {
      fetch: shellThenEmbed(id, {
        itemInfos: {
          id,
          text: "Watermarked fallback",
          video: { urls: ["https://v77.tiktokcdn.com/token/mps/logo/v2/main.mp4"], videoMeta: { duration: 10 } },
        },
        authorInfos: { uniqueId: "creator", nickName: "Creator", verified: false },
        musicInfos: {},
        imagePostInfo: { displayImages: [] },
      }, requests),
    });

    await expect(result).rejects.toThrow("TikTok hydration not found");
    expect(requests.some(({ url }) => url.includes("/embed/v2/"))).toBe(false);
  });
});
