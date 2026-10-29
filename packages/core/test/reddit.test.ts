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

describe("Reddit website previews", () => {
  const preview = "https://external-preview.redd.it/studio.jpg?auto=webp&s=signature";
  const card = {
    post_hint: "link", is_self: false, url: "https://www.apple.com/shop/buy-mac/mac-studio",
    preview: { enabled: false, images: [{
      source: { url: preview.replaceAll("&", "&amp;"), width: 1200, height: 630 },
      resolutions: [{ url: "https://external-preview.redd.it/small.jpg", width: 320, height: 168 }],
    }] },
  };
  async function resolvePost(fields: Record<string, unknown>) {
    const requests: string[] = [];
    const result = await postfetch(url, { fetch: (async (input) => {
      const target = String(input);
      requests.push(target);
      if (target.includes("access_token")) return Response.json({ access_token: "test-token" });
      if (target.includes("oauth.reddit.com/comments/")) return Response.json([{ data: { children: [{ data: {
        id, title: "Mac Studio", subreddit: "LocalLLaMA", ...fields,
      } }] } }]);
      throw new Error(`Unexpected URL: ${target}`);
    }) as typeof fetch });
    expect(requests).toHaveLength(2);
    return result;
  }

  test("uses Reddit's original card image even when preview.enabled is false", async () => {
    const result = await resolvePost(card);
    expect(result.items).toMatchObject([{
      id, platform: "reddit", kind: "image", mime: "image/jpeg", role: "linkPreview",
      filename: `reddit_${id}_preview.jpg`, url: preview,
    }]);
    expect(result.items).toHaveLength(1);
    expect(result.metadata).toMatchObject({ title: "Mac Studio", extra: { subreddit: "LocalLLaMA" } });
  });

  test("uses the largest valid resolution when the source is missing or invalid", async () => {
    const result = await resolvePost({ ...card, preview: { images: [{
      source: { url: "javascript:invalid" },
      resolutions: [
        { url: "https://external-preview.redd.it/small.png", width: 320, height: 168 },
        { url: "not a URL", width: 9999, height: 9999 },
        { url: "https://external-preview.redd.it/large.png", width: 1080, height: 567 },
      ],
    }] } });
    expect(result.items).toMatchObject([{
      url: "https://external-preview.redd.it/large.png", mime: "image/png", filename: `reddit_${id}_preview.png`,
    }]);
  });

  test.each([null, {}, { images: [null, { source: { url: "file:///tmp/card.jpg" } }] }])("ignores missing or malformed preview data: %j", async (preview) => {
    expect((await resolvePost({ ...card, preview, thumbnail: "https://example.com/tiny.jpg" })).items).toEqual([]);
  });

  test.each([
    { is_self: true },
    { url: "https://www.reddit.com/r/pics/comments/other/" },
    { url: "https://redd.it/other" },
    { url: "mailto:someone@example.com" },
    { url: undefined },
  ])("does not treat non-link posts as website cards: %j", async (fields) => {
    expect((await resolvePost({ ...card, ...fields })).items).toEqual([]);
  });

  test("does not duplicate an image post with its preview", async () => {
    const result = await resolvePost({ ...card, post_hint: "image", url: "https://i.redd.it/photo.jpg" });
    expect(result.items).toMatchObject([{ url: "https://i.redd.it/photo.jpg" }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].role).toBeUndefined();
  });

  test("retains a crosspost's gallery instead of downloading its card image", async () => {
    const result = await resolvePost({ ...card, crosspost_parent_list: [{
      gallery_data: { items: [{ media_id: "photo" }] },
      media_metadata: { photo: { m: "image/jpeg", s: { u: "https://i.redd.it/photo.jpg" } } },
    }] });
    expect(result.items).toMatchObject([{ url: "https://i.redd.it/photo.jpg" }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].role).toBeUndefined();
  });

  test("inherits an external link preview from a crosspost", async () => {
    const result = await resolvePost({
      url: "https://www.reddit.com/r/pics/comments/other/", crosspost_parent_list: [card],
    });
    expect(result.items).toMatchObject([{ id, role: "linkPreview", url: preview }]);
  });
});

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

describe("Reddit GraphQL comment fallback", () => {
  const tree = (id: string, fields: Record<string, unknown> = {}, treeFields: Record<string, unknown> = {}) => ({
    depth: 0, parentId: null, node: {
      __typename: "Comment", id: `t1_${id}`, authorInfo: { name: "reader" },
      content: { markdown: `Comment ${id}`, richtextMedia: [] },
      createdAt: "2026-10-23T20:28:11.169000+0000", score: 23, ...fields,
    }, ...treeFields,
  });
  const continuation = (cursor: string, fields: Record<string, unknown> = {}) => ({ depth: 0, parentId: null, more: { cursor }, ...fields });
  const page = (...trees: unknown[]) => ({ data: { postInfoById: { commentForest: { trees } } } });

  async function fallback(limit: number, pages: unknown[], blockExpansion = false) {
    const requests: { url: string; body: Record<string, unknown> & { variables: Record<string, unknown> & { count: number; after?: string } } }[] = [];
    const result = await postfetch(url, { comments: limit, fetch: (async (input, init) => {
      const target = String(input);
      if (target.includes("access_token")) return Response.json({ access_token: "test-token" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      if (target.includes("by_id")) return Response.json(listing([])[0]);
      if (target.includes("oauth.reddit.com")) {
        if (blockExpansion && target.includes("sort=top") && !target.includes("morechildren")) return Response.json(listing([comment("old"), more("b")]));
        return new Response("Blocked", { status: 403 });
      }
      expect(target).toBe("https://gql-fed.reddit.com/");
      requests.push({ url: target, body: JSON.parse(String(init?.body)) });
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      const next = pages.shift();
      if (next === undefined) throw new Error("offline");
      return next instanceof Response ? next : Response.json(next);
    }) as typeof fetch });
    return { result, requests: requests.filter((request) => request.url.includes("gql-fed")) };
  }

  test("uses the same token for top comments when OAuth comments are forbidden", async () => {
    const { result, requests } = await fallback(2, [page(
      tree("deleted", { __typename: "DeletedComment" }), tree("removed", { isRemoved: true }),
      tree("admin", { isAdminTakedown: true }), tree("placeholder", { content: { markdown: "[deleted]" } }),
      tree("nested", {}, { depth: 1, parentId: "t1_a" }), tree("wrong", {}, { parentId: "t3_other" }),
      tree("a"), tree("a"), tree("b"), tree("c"),
    )]);
    expect(result.comments.map((comment) => comment.id)).toEqual(["a", "b"]);
    expect(result.comments[0]).toMatchObject({
      url: `https://www.reddit.com/comments/${id}/_/a/`,
      metadata: { text: "Comment a", author: { handle: "reader" }, likeCount: 23, createdAt: "2026-10-23T20:28:11.000Z" },
    });
    expect(result.metadata?.text).toBe("Root");
    expect(requests[0].body).toEqual({
      operationName: "PostComments",
      variables: { id: `t3_${id}`, sortType: "TOP", count: 2, maxDepth: 1, includeConsistencyToken: false, includePremiumAvatarTreatment: false },
      extensions: { persistedQuery: { version: 1, sha256Hash: "314f29c2494fd78c7844ef2c6b09acb4bef5b37ab50b4ddc01691d6d5c8433f8" } },
    });
  });

  test("paginates root cursors, ignores nested cursors and stops repeated cursors", async () => {
    const { result, requests } = await fallback(205, [
      page(tree("a"), continuation("next"), continuation("nested", { depth: 1, parentId: "t1_a" })),
      page(tree("a"), tree("b"), continuation("next")),
    ]);
    expect(result.comments.map((comment) => comment.id)).toEqual(["a", "b"]);
    expect(requests.map((request) => request.body.variables.count)).toEqual([200, 200]);
    expect(requests.map((request) => request.body.variables.after)).toEqual([undefined, "next"]);
  });

  test("requests only the remaining comments on the next page", async () => {
    const { result, requests } = await fallback(3, [page(tree("a"), continuation("next")), page(tree("b"))]);
    expect(result.comments).toHaveLength(2);
    expect(requests.map((request) => request.body.variables.count)).toEqual([3, 2]);
  });

  test("keeps inline image and GIF order and cleans their markers", async () => {
    const { result } = await fallback(5, [page(tree("a", { content: {
      markdown: "Look\n![gif](giphy|g)\n![img](photo)\nhttps://example.com/image.jpg\n![img](missing)",
      richtextMedia: [
        { id: "photo", status: "VALID", mimetype: "image/jpeg", url: "https://i.redd.it/photo.jpg" },
        { id: "giphy|g", status: "VALID", mimetype: "image/gif", url: "https://external-preview.redd.it/g.gif" },
        { id: "missing", status: "FAILED", url: "https://i.redd.it/missing.jpg" },
      ],
    } }))]);
    expect(result.comments[0].items.map((item) => item.mime)).toEqual(["image/gif", "image/jpeg"]);
    expect(result.comments[0].metadata.text).toBe("Look\n\n\nhttps://example.com/image.jpg\n![img](missing)");
  });

  test("falls back when expansion is forbidden and replaces the partial JSON list", async () => {
    const { result } = await fallback(5, [page(tree("a"))], true);
    expect(result.comments.map((comment) => comment.id)).toEqual(["a"]);
  });

  test("accepts an empty forest", async () => {
    const { result } = await fallback(5, [page()]);
    expect(result.comments).toEqual([]);
  });

  test.each([null, {}, { errors: [{ message: "PersistedQueryNotFound" }] }, new Response("invalid"), new Response(null, { status: 403 })])("preserves the root on GraphQL failure: %j", async (response) => {
    const { result } = await fallback(5, [response]);
    expect(result.comments).toEqual([]);
    expect(result.metadata?.text).toBe("Root");
  });

  test("returns no comments when a later GraphQL page fails", async () => {
    const { result } = await fallback(5, [page(tree("a"), continuation("next"))]);
    expect(result.comments).toEqual([]);
    expect(result.metadata?.text).toBe("Root");
  });
});
