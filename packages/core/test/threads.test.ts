import { describe, expect, test } from "bun:test";
import { detect, postfetch, PostfetchError } from "../src/index";
import { threadsMetadata } from "../src/threads";

function pageHtml(scripts: unknown[]): string {
  return `<html><body>${scripts.map((data) => `<script type="application/json" data-sjs>${JSON.stringify(data)}</script>`).join("")}</body></html>`;
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("threads resolver", () => {
  test("detects threads.com and threads.net hosts and rejects lookalikes", () => {
    expect(detect("https://www.threads.com/share/BADl3Yd6fC")).toBe("threads");
    expect(detect("https://threads.com/@user/post/DgOFm0VjRlw")).toBe("threads");
    expect(detect("https://www.threads.net/@user/post/DgOFm0VjRlw")).toBe("threads");
    expect(detect("https://threads.net/t/DgOFm0VjRlw")).toBe("threads");
    expect(() => detect("https://notthreads.com/share/BADl3Yd6fC")).toThrow(PostfetchError);
    expect(() => detect("https://threads.com.example.com/share/BADl3Yd6fC")).toThrow(PostfetchError);
  });

  test("resolves a /share/ link via redirect to a video post with metadata", async () => {
    const requested: string[] = [];
    const html = pageHtml([
      {
        require: [[["ScheduledServerJS", "handle", null, [{
          __bbox: {
            require: [[["RelayPrefetchedStreamCache", "next", [], ["adp_query", {
              __bbox: {
                result: {
                  data: {
                    media: {
                      pk: "4039190573566728560",
                      id: "4039190573566728560_72131282313",
                      code: "DgOFm0VjRlw",
                      taken_at: 1795729801,
                      media_type: 2,
                      like_count: 2512,
                      caption: { text: "Hello from Threads!" },
                      user: { username: "maksym.trach", full_name: "Maksym Trach", is_verified: true },
                      video_versions: [
                        { type: 101, url: "https://cdn.test/video-720.mp4", width: 720, height: 1280 },
                        { type: 102, url: "https://cdn.test/video-360.mp4", width: 360, height: 640 },
                      ],
                      image_versions2: {
                        candidates: [{ url: "https://cdn.test/poster.jpg", width: 640, height: 360 }],
                      },
                      text_post_app_info: {
                        direct_reply_count: 113,
                        repost_count: 20,
                        quote_count: 2,
                        is_reply: false,
                      },
                    },
                  },
                },
              },
            }]]]],
          },
        }]]]],
      },
    ]);

    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url === "https://www.threads.com/share/BADl3Yd6fC") {
        expect(init?.redirect).toBe("manual");
        return redirectResponse("https://www.threads.com/@maksym.trach/post/DgOFm0VjRlw?xmt=abc&slof=1");
      }
      if (url === "https://www.threads.com/@maksym.trach/post/DgOFm0VjRlw") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/share/BADl3Yd6fC", { fetch });
    expect(requested).toEqual([
      "https://www.threads.com/share/BADl3Yd6fC",
      "https://www.threads.com/@maksym.trach/post/DgOFm0VjRlw",
    ]);
    expect(result.platform).toBe("threads");
    expect(result.id).toBe("DgOFm0VjRlw");
    expect(result.archiveFilename).toBe("threads_DgOFm0VjRlw.zip");
    expect(result.items).toEqual([
      expect.objectContaining({
        filename: "threads_DgOFm0VjRlw.mp4",
        id: "DgOFm0VjRlw",
        kind: "video",
        mime: "video/mp4",
        platform: "threads",
        url: "https://cdn.test/video-720.mp4",
      }),
    ]);
    expect(result.metadata).toEqual({
      text: "Hello from Threads!",
      author: { handle: "maksym.trach", name: "Maksym Trach", verified: true },
      createdAt: "2026-11-26T21:50:01.000Z",
      likeCount: 2512,
      commentCount: 113,
      shareCount: 20,
      extra: { isReply: false, quoteCount: 2 },
    });
  });

  test("honors preferredWidth and tryMaxBytes for Threads videos", async () => {
    const html = pageHtml([{
      data: {
        media: {
          code: "Vid1",
          caption: { text: "Clip" },
          video_versions: [
            { url: "https://cdn.test/hd.mp4", width: 720, height: 1280 },
            { url: "https://cdn.test/sd.mp4", width: 360, height: 640 },
          ],
        },
      },
    }]);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "HEAD") {
        const bytes = url.endsWith("hd.mp4") ? 60_000_000 : 20_000_000;
        return new Response(null, { headers: { "content-length": String(bytes) } });
      }
      if (url === "https://www.threads.com/@u/post/Vid1") {
        return new Response(html);
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/@u/post/Vid1", { fetch, tryMaxBytes: 50_000_000 });
    expect(result.items[0]?.url).toBe("https://cdn.test/sd.mp4");
  });

  test("resolves /t/ shortlink and selects highest-resolution image preserving webp mime", async () => {
    const html = pageHtml([{
      data: {
        media: {
          code: "Img1",
          caption: { text: "Photo post" },
          image_versions2: {
            candidates: [
              { url: "https://cdn.test/small.webp", width: 480, height: 480 },
              { url: "https://cdn.test/large.webp?foo=1", width: 1080, height: 1080 },
            ],
          },
        },
      },
    }]);
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://www.threads.net/t/Img1") {
        return redirectResponse("https://www.threads.com/@author/post/Img1", 301);
      }
      if (url === "https://www.threads.com/@author/post/Img1") {
        return new Response(html);
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.net/t/Img1", { fetch });
    expect(result.items).toEqual([
      expect.objectContaining({
        filename: "threads_Img1.webp",
        kind: "image",
        mime: "image/webp",
        url: "https://cdn.test/large.webp?foo=1",
      }),
    ]);
  });

  test("resolves mixed video and image carousels in order", async () => {
    const html = pageHtml([{
      data: {
        media: {
          code: "Car1",
          caption: { text: "Carousel" },
          carousel_media: [
            {
              video_versions: [{ url: "https://cdn.test/c1.mp4", width: 720, height: 960 }],
              image_versions2: { candidates: [{ url: "https://cdn.test/c1-thumb.jpg", width: 640, height: 852 }] },
            },
            {
              image_versions2: { candidates: [{ url: "https://cdn.test/c2.jpg", width: 1080, height: 1080 }] },
            },
          ],
        },
      },
    }]);
    const fetch = (async () => new Response(html)) as unknown as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/@u/post/Car1", { fetch });
    expect(result.items).toEqual([
      expect.objectContaining({ filename: "threads_Car1_1.mp4", kind: "video", mime: "video/mp4", url: "https://cdn.test/c1.mp4" }),
      expect.objectContaining({ filename: "threads_Car1_2.jpg", kind: "image", mime: "image/jpeg", url: "https://cdn.test/c2.jpg" }),
    ]);
  });

  test("resolves text-only posts with empty image candidates to metadata with no media", async () => {
    const html = pageHtml([{
      data: {
        media: {
          code: "Txt1",
          media_type: 19,
          caption: { text: "Just words" },
          image_versions2: { candidates: [] },
          user: { username: "writer", full_name: "Writer", is_verified: false },
          text_post_app_info: { direct_reply_count: 5 },
        },
      },
    }]);
    const fetch = (async () => new Response(html)) as unknown as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/@writer/post/Txt1", { fetch });
    expect(result.platform).toBe("threads");
    expect(result.items).toEqual([]);
    expect(result.metadata).toMatchObject({
      text: "Just words",
      author: { handle: "writer", name: "Writer", verified: false },
      commentCount: 5,
    });
  });

  test("resolves quoted posts, link previews, and voice posts", async () => {
    const html = pageHtml([{
      data: {
        media: {
          code: "Outer1",
          caption: { text: "Look at this" },
          audio: { audio_src: "https://cdn.test/voice.m4a" },
          text_post_app_info: {
            link_preview_attachment: { image_url: "https://cdn.test/preview.png" },
            share_info: {
              quoted_post: {
                code: "Quoted1",
                caption: { text: "Quoted text" },
                user: { username: "quoted", full_name: "Quoted User", is_verified: true },
                image_versions2: { candidates: [{ url: "https://cdn.test/quoted.jpg", width: 800, height: 600 }] },
              },
            },
          },
        },
      },
    }]);
    const fetch = (async () => new Response(html)) as unknown as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/@outer/post/Outer1", { fetch });
    if (result.platform !== "threads") throw new Error("expected threads");
    expect(result.items).toEqual([
      expect.objectContaining({ id: "Outer1", kind: "audio", mime: "audio/mp4", url: "https://cdn.test/voice.m4a" }),
      expect.objectContaining({ id: "Quoted1", kind: "image", mime: "image/jpeg", url: "https://cdn.test/quoted.jpg" }),
      expect.objectContaining({ id: "Outer1", kind: "image", mime: "image/png", role: "linkPreview", url: "https://cdn.test/preview.png" }),
    ]);
    expect(result.metadata?.extra?.quotedPost).toEqual({
      id: "Quoted1",
      metadata: expect.objectContaining({
        text: "Quoted text",
        author: { handle: "quoted", name: "Quoted User", verified: true },
      }),
    });
  });

  test("extracts self-thread replies before direct replies when comments are requested", async () => {
    const html = pageHtml([
      {
        data: {
          media: {
            id: "100_1",
            pk: "100",
            code: "Root1",
            caption: { text: "Thread 1/2" },
            user: { username: "alice", full_name: "Alice" },
          },
        },
      },
      {
        data: {
          media: {
            id: "100_1",
            text_post_app_info: {
              self_thread: {
                posts: {
                  edges: [
                    {
                      node: {
                        code: "Self2",
                        caption: { text: "Thread 2/2" },
                        user: { username: "alice", full_name: "Alice" },
                        image_versions2: { candidates: [{ url: "https://cdn.test/self2.jpg", width: 500, height: 500 }] },
                      },
                    },
                  ],
                },
              },
              direct_replies: {
                edges: [
                  {
                    node: {
                      posts: {
                        edges: [{ node: { code: "Reply1", caption: { text: "Other reply" }, user: { username: "bob" } } }],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const fetch = (async () => new Response(html)) as unknown as typeof globalThis.fetch;

    const withComments = await postfetch("https://www.threads.com/@alice/post/Root1", { fetch, comments: 5 });
    expect(withComments.comments).toEqual([
      expect.objectContaining({
        id: "Self2",
        url: "https://www.threads.com/@alice/post/Self2",
        metadata: expect.objectContaining({ text: "Thread 2/2" }),
        items: [expect.objectContaining({ kind: "image", url: "https://cdn.test/self2.jpg" })],
      }),
    ]);

    const withoutComments = await postfetch("https://www.threads.com/@alice/post/Root1", { fetch });
    expect(withoutComments.comments).toEqual([]);
  });

  test("falls back to direct replies when there is no self-thread", async () => {
    const html = pageHtml([
      { data: { media: { id: "200_1", code: "Root2", caption: { text: "Main" } } } },
      {
        data: {
          media: {
            id: "200_1",
            text_post_app_info: {
              self_thread: { posts: { edges: [] } },
              direct_replies: {
                edges: [
                  { node: { posts: { edges: [{ node: { code: "R1", caption: { text: "First" }, user: { username: "u1" } } }] } } },
                  { node: { posts: { edges: [{ node: { code: "R2", caption: { text: "Second" }, user: { username: "u2" } } }] } } },
                ],
              },
            },
          },
        },
      },
    ]);
    const fetch = (async () => new Response(html)) as unknown as typeof globalThis.fetch;

    const result = await postfetch("https://www.threads.com/@a/post/Root2", { fetch, comments: 1 });
    expect(result.comments.map((c) => c.id)).toEqual(["R1"]);
  });

  test("rejects profile URLs, invalid share links, off-host redirects, login walls, and missing posts", async () => {
    const noopFetch = (async () => new Response("<html></html>")) as unknown as typeof globalThis.fetch;
    await expect(postfetch("https://www.threads.com/@maksym.trach", { fetch: noopFetch })).rejects.toMatchObject({ status: 400 });
    await expect(postfetch("https://www.threads.com/share/", { fetch: noopFetch })).rejects.toMatchObject({ status: 400 });
    await expect(postfetch("https://www.threads.com/@maksym.trach/post/MISSING", { fetch: noopFetch })).rejects.toMatchObject({
      reason: "notFound",
      status: 404,
    });

    const offHostFetch = (async () => redirectResponse("https://evil.example/@u/post/ABC")) as unknown as typeof globalThis.fetch;
    await expect(postfetch("https://www.threads.com/share/BAD", { fetch: offHostFetch })).rejects.toMatchObject({
      reason: "notFound",
      status: 404,
    });

    const loginFetch = (async () => redirectResponse("https://www.threads.com/login")) as unknown as typeof globalThis.fetch;
    await expect(postfetch("https://www.threads.com/share/LOGIN", { fetch: loginFetch })).rejects.toMatchObject({
      reason: "loginRequired",
      status: 401,
    });

    const rateLimitFetch = (async () => new Response("too many", { status: 429 })) as unknown as typeof globalThis.fetch;
    await expect(postfetch("https://www.threads.com/share/LIMIT", { fetch: rateLimitFetch })).rejects.toMatchObject({
      reason: "rateLimited",
      status: 429,
    });
  });

  test("omits hidden like counts and reads fallback text_fragments", () => {
    const meta = threadsMetadata({
      like_count: 99,
      like_and_view_counts_disabled: true,
      taken_at: 1795729801,
      user: { username: "u", full_name: "Name", is_verified: false },
      text_post_app_info: {
        is_reply: true,
        reply_to_post_id: "12345",
        text_fragments: {
          fragments: [{ plaintext: "Hello " }, { plaintext: "world" }],
        },
      },
    });
    expect(meta).toEqual({
      text: "Hello world",
      author: { handle: "u", name: "Name", verified: false },
      createdAt: "2026-11-26T21:50:01.000Z",
      likeCount: undefined,
      commentCount: undefined,
      shareCount: undefined,
      extra: { isReply: true, replyToId: "12345" },
    });
  });
});
