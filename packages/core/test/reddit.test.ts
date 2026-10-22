import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

const id = "1ugzn9p";
const url = `https://www.reddit.com/r/pics/comments/${id}/seen_in_the_uk/`;
const comment = (id: string, fields: Record<string, unknown> = {}) => ({ kind: "t1", data: {
  id, parent_id: "t3_1ugzn9p", author: "reader", body: `Comment ${id}`, ups: 23, created_utc: 1788950400, ...fields,
} });
const more = (...children: string[]) => ({ kind: "more", data: { parent_id: "t3_1ugzn9p", children } });
const listing = (children: unknown[]) => [{ data: { children: [{ data: { id, title: "Post", selftext: "Root" } }] } }, { data: { children } }];
async function resolve(comments: number | undefined, pages: unknown[] = []) {
  const requests: string[] = [];
  const result = await postfetch(url, { comments, fetch: (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("access_token")) return Response.json({ access_token: "test-token" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    if (!url.includes("sort=top")) return Response.json(listing([]));
    const page = pages.shift();
    if (page === undefined) throw new Error("offline");
    return page instanceof Response ? page : Response.json(page);
  }) as typeof fetch });
  return { result, requests };
}

describe("Reddit post lookup fallback", () => {
  const post = {
    id: "1xchebs", title: "Apple заблокировала все iPhone Duo", selftext: "Post body", subreddit: "KafkaFPS",
    post_hint: "image", url: "https://i.redd.it/y02w5nv4k0xh1.jpeg",
  };
  const postUrl = "https://www.reddit.com/r/KafkaFPS/comments/1xchebs/apple_%D0%B7%D0%B0%D0%B1%D0%BB%D0%BE%D0%BA%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%D0%BB%D0%B0/";
  const directListing = { kind: "Listing", data: { children: [{ kind: "t3", data: post }] } };

  function fetcher(fallback: Response, status = 403) {
    const requests: string[] = [];
    let postHeaders: Headers | undefined;
    const fetch = (async (input, init) => {
      const target = String(input);
      requests.push(target);
      if (target === "https://www.reddit.com/api/v1/access_token") return Response.json({ access_token: "test-token" });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-token");
      if (target === "https://oauth.reddit.com/comments/1xchebs?raw_json=1&limit=1") {
        postHeaders = headers;
        return new Response("Blocked", { status });
      }
      expect(target).toBe("https://oauth.reddit.com/by_id/t3_1xchebs?raw_json=1");
      expect([...headers]).toEqual([...postHeaders!]);
      return fallback;
    }) as typeof globalThis.fetch;
    return { fetch, requests };
  }

  test("resolves media and metadata through by_id when comments are forbidden", async () => {
    const { fetch, requests } = fetcher(Response.json(directListing));
    const result = await postfetch(postUrl, { fetch });
    expect(requests).toHaveLength(3);
    expect(result.id).toBe("1xchebs");
    expect(result.items).toMatchObject([{ kind: "image", mime: "image/jpeg", url: post.url }]);
    expect(result.metadata).toMatchObject({ title: post.title, text: post.selftext, extra: { subreddit: "KafkaFPS" } });
  });

  test("reports a forbidden fallback instead of returning an empty text post", async () => {
    const { fetch } = fetcher(new Response("Blocked", { status: 403 }));
    await expect(postfetch(postUrl, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test.each([null, {}, { data: { children: [] } }])("rejects an invalid or missing direct post: %j", async (payload) => {
    const { fetch } = fetcher(Response.json(payload));
    await expect(postfetch(postUrl, { fetch })).rejects.toThrow("Reddit post not found");
  });

  test("does not fall back for other HTTP failures", async () => {
    const { fetch, requests } = fetcher(Response.json(directListing), 404);
    await expect(postfetch(postUrl, { fetch })).rejects.toThrow("Reddit post failed: 404");
    expect(requests).toHaveLength(2);
  });
});

describe("Reddit comments", () => {
  test.each([undefined, 0, -1, 1.5, NaN, Infinity])("does not fetch comments for %s", async (limit) => {
    const { result, requests } = await resolve(limit);
    expect(result.comments).toEqual([]);
    expect(requests).toHaveLength(2);
  });
  test("caps direct comments, ignores deleted/nested entries and duplicate IDs", async () => {
    const { result, requests } = await resolve(2, [listing([
      comment("a", { body: "[deleted]" }), comment("b", { parent_id: "t1_other" }), comment("c"), comment("c"), comment("d"), comment("e"),
    ])]);
    expect(result.comments.map((c) => c.id)).toEqual(["c", "d"]);
    expect(result.comments[0].metadata).toMatchObject({ author: { handle: "reader" }, text: "Comment c", likeCount: 23 });
    expect(result.comments[0].url).toBe(`https://www.reddit.com/comments/${id}/_/c/`);
    expect(new URL(requests[2]).searchParams.get("sort")).toBe("top");
    expect(result.items).toEqual([]);
  });
  test("extracts comment photos and GIF MP4s, removing their embedded markers and bare URLs", async () => {
    const photo = "https://preview.redd.it/p.jpg?width=200&format=pjpg";
    const { result } = await resolve(5, [listing([comment("a", {
      body: `Look\n${photo}\n![gif](giphy|g)`, media_metadata: {
        p: { m: "image/jpeg", s: { u: photo } },
        "giphy|g": { m: "image/gif", s: { gif: "https://preview.redd.it/g.gif", mp4: "https://preview.redd.it/g.mp4" } },
      },
    })])]);
    expect(result.comments[0].items.map((i) => i.kind)).toEqual(["image", "video"]);
    expect(result.comments[0].metadata.text).toBe("Look");
  });
  test("accepts fewer comments and preserves unrelated links", async () => {
    const { result } = await resolve(8, [listing([comment("a", { body: "https://example.com/photo.jpg" })])]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].items).toEqual([]);
    expect(result.comments[0].metadata.text).toBe("https://example.com/photo.jpg");
  });
  test("expands morechildren with the same token and stops repeated IDs", async () => {
    const { result, requests } = await resolve(5, [listing([comment("a"), more("b", "c")]),
      { json: { errors: [], data: { things: [comment("b"), comment("c", { parent_id: "t1_b" }), more("b", "c")] } } },
    ]);
    expect(result.comments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(new URL(requests[3]).searchParams.get("children")).toBe("b,c");
  });
  test.each([null, {}, new Response("invalid"), new Response(null, { status: 503 })])("preserves root on comment failure: %j", async (page) => {
    const { result } = await resolve(5, [page]);
    expect(result.comments).toEqual([]);
    expect(result.metadata?.text).toBe("Root");
  });
  test("returns [] when a later page fails", async () => {
    const { result } = await resolve(5, [listing([comment("a"), more("b")])]);
    expect(result.comments).toEqual([]);
  });
});
