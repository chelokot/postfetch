import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

const id = "1xo45dd";
const share = "https://www.reddit.com/r/teenagers/s/tsStUVox8L";
const canonical = `https://www.reddit.com/r/teenagers/comments/${id}/haircut/?share_id=test`;
const image = "https://i.redd.it/954zzk8gqozh1.jpeg";
const page = `<shreddit-post id="t3_${id}" post-type="image" content-href="${image}"
  post-title="Haircut &amp; fade &#x1F600; &quot;photo&quot;" author="Midoriyer" subreddit-name="teenagers"
  created-timestamp="2026-11-05T00:03:43.418000+0000" score="16300" comment-count="1039"
  upvote-ratio="0.98" permalink="/r/teenagers/comments/${id}/haircut/">
  <img src="https://preview.redd.it/thumbnail.jpeg">
</shreddit-post><shreddit-post id="t3_other" post-type="image" content-href="https://i.redd.it/other.jpeg">`;
const challenge = `<script>var n=await(async e=>e+e)("03ddd0ef77f57352");</script>
  <form hidden method="GET" action="/r/teenagers/comments/${id}/haircut/">
  <input type="hidden" name="solution" /><input name="js_challenge" value="1"/>
  <input name="jsc_token" value="test-token"/><input name="jsc_orig_r" value=""/></form>`;

function webPost(type: string, destination: string, body = ""): string {
  return `<shreddit-post id="t3_${id}" post-type="${type}" content-href="${destination}" post-title="Post">${body}</shreddit-post>`;
}

const player = `<shreddit-player post-id="t3_${id}" src="https://v.redd.it/clip/HLSPlaylist.m3u8?a=signature" poster="${image}"></shreddit-player>`;
const videoManifest = `<MPD><Period><AdaptationSet contentType="video" mimeType="video/mp4">
  <Representation width="480" bandwidth="500000"><BaseURL>DASH_480.mp4</BaseURL></Representation>
  <Representation width="1280" bandwidth="2000000"><BaseURL>DASH_720.mp4</BaseURL></Representation>
</AdaptationSet>`;
const audioManifest = `<AdaptationSet contentType="audio" mimeType="audio/mp4">
  <Representation bandwidth="128000"><BaseURL>DASH_AUDIO_128.mp4</BaseURL></Representation>
</AdaptationSet>`;

function feed(content: string, postId = id): string {
  const encoded = content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<feed><entry><id>t1_comment</id><title>Comment</title><content type="html">&lt;a href="https://i.redd.it/comment.jpg"&gt;[link]&lt;/a&gt;</content></entry>
  <entry><id>t3_${postId}</id><title>Feed &amp; post</title><author><name>/u/Midoriyer</name></author><category term="teenagers" label="r/teenagers"/>
  <content type="html">${encoded}</content><link href="${canonical.replaceAll('&','&amp;')}"/>
  <published>2026-11-05T00:03:43+00:00</published></entry></feed>`;
}

function response(body: string, url = canonical, headers: HeadersInit = {}): Response {
  const result = new Response(body, { headers });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function fixture(options: { html?: string; challenge?: string; webStatus?: number; apiStatus?: number; apiSuccess?: boolean; manifest?: string; rss?: string; rssReset?: string } = {}) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  let rssRequests = 0;
  const fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });
    if (url === share || url === canonical) {
      if (options.webStatus) {
        const result = new Response("Unavailable", { status: options.webStatus });
        Object.defineProperty(result, "url", { value: canonical });
        return result;
      }
      return options.challenge
        ? response(options.challenge, canonical, { "set-cookie": "edge=test; Path=/; Secure; HttpOnly" })
        : response(options.html ?? page);
    }
    if (url.endsWith("/access_token")) return Response.json({ access_token: "oauth-token" });
    if (url.startsWith("https://oauth.reddit.com/")) {
      if (options.apiSuccess) return Response.json([{ data: { children: [{ data: { id, title: "API post", url: image } }] } }]);
      return new Response("Blocked", { status: options.apiStatus ?? 403 });
    }
    expect(headers.has("authorization")).toBe(false);
    if (url === `https://www.reddit.com/comments/${id}?embedded=true`) return new Response(null, { status: 403 });
    if (url === `https://www.reddit.com/comments/${id}/.rss?limit=1`) {
      rssRequests++;
      if (rssRequests === 1 && options.rssReset !== undefined) return new Response(null, { status: 429, headers: { "x-ratelimit-reset": options.rssReset } });
      return options.rss ? new Response(options.rss, { headers: { "content-type": "application/atom+xml" } }) : new Response(null, { status: 403 });
    }
    if (url.startsWith("https://v.redd.it/clip/DASHPlaylist.mpd")) {
      expect(url).toBe("https://v.redd.it/clip/DASHPlaylist.mpd?a=signature");
      return new Response(options.manifest ?? "Invalid manifest");
    }
    if (options.webStatus) return new Response("Unavailable", { status: options.webStatus });
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe(canonical.split("?")[0]);
    expect(target.searchParams.get("solution")).toBe("03ddd0ef77f5735203ddd0ef77f57352");
    expect(target.searchParams.get("share_id")).toBe("test");
    expect(target.searchParams.get("jsc_token")).toBe("test-token");
    expect(headers.get("cookie")).toBe("edge=test");
    expect(headers.get("user-agent")).toBe(requests[0]!.headers.get("user-agent"));
    return response(options.html ?? page, url);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("Reddit public page fallback", () => {
  test.each([false, true])("resolves a share link after both API routes return 403 (challenge=%s)", async (withChallenge) => {
    const { fetch, requests } = fixture({ challenge: withChallenge ? challenge : undefined });
    const result = await postfetch(share, { fetch });
    expect(requests.map((request) => request.url).slice(0, 4)).toEqual([
      share, "https://www.reddit.com/api/v1/access_token",
      `https://oauth.reddit.com/comments/${id}?raw_json=1&limit=1`,
      `https://oauth.reddit.com/by_id/t3_${id}?raw_json=1`,
    ]);
    expect(requests).toHaveLength(withChallenge ? 5 : 4);
    expect(result.items).toMatchObject([{ kind: "image", url: image, filename: `reddit_${id}.jpg` }]);
    expect(result.items).toHaveLength(1);
    expect(result.metadata).toMatchObject({
      title: 'Haircut & fade 😀 "photo"', author: { handle: "Midoriyer" },
      createdAt: "2026-11-05T00:03:43.000Z", likeCount: 16300, commentCount: 1039,
      extra: { subreddit: "teenagers", score: 16300, upvoteRatio: 0.98 },
    });
  });

  test("keeps successful API resolution without requesting HTML", async () => {
    const { fetch, requests } = fixture({ apiSuccess: true });
    expect((await postfetch(share, { fetch })).metadata?.title).toBe("API post");
    expect(requests).toHaveLength(3);
  });

  test("fetches canonical links only after the API rejects both lookups", async () => {
    const { fetch, requests } = fixture();
    expect((await postfetch(canonical, { fetch })).items[0]?.url).toBe(image);
    expect(requests.map((request) => request.url)).toEqual([
      "https://www.reddit.com/api/v1/access_token",
      `https://oauth.reddit.com/comments/${id}?raw_json=1&limit=1`,
      `https://oauth.reddit.com/by_id/t3_${id}?raw_json=1`, canonical,
    ]);
  });

  test("keeps the JS-check cookie when its success response redirects", async () => {
    const base = fixture({ challenge });
    const final = canonical + "&verified=1";
    let finalRequests = 0;
    const fetch = (async (input, init) => {
      const url = String(input);
      if (url === final) {
        finalRequests++;
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("manual");
        expect(headers.get("cookie")).toBe("edge=test; session=accepted");
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("user-agent")).toBe(base.requests[0]!.headers.get("user-agent"));
        return response(page, final);
      }
      const result = await base.fetch(input, init);
      if (new URL(url).searchParams.has("solution")) {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: final, "set-cookie": "session=accepted; Path=/; Secure; HttpOnly" } });
      }
      return result;
    }) as typeof globalThis.fetch;
    expect((await postfetch(share, { fetch })).items[0].url).toBe(image);
    expect(finalRequests).toBe(1);
  });

  test("bounds repeated redirects instead of looping on a public page", async () => {
    const base = fixture();
    let redirects = 0;
    const fetch = (async (input, init) => {
      if (String(input) === canonical) {
        redirects++;
        return new Response(null, { status: 302, headers: { location: canonical } });
      }
      return base.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(postfetch(canonical, { fetch })).rejects.toThrow("Reddit post failed: 403");
    expect(redirects).toBe(6);
  });

  test("does not follow public-page redirects outside Reddit", async () => {
    const base = fixture();
    const fetch = (async (input, init) => String(input) === canonical
      ? new Response(null, { status: 302, headers: { location: "https://example.com/" } })
      : base.fetch(input, init)) as typeof globalThis.fetch;
    await expect(postfetch(canonical, { fetch })).rejects.toThrow("Reddit post failed: 403");
    expect(base.requests).toHaveLength(5);
  });

  for (const type of ["video", "gif"]) {
    for (const audio of [true, false]) {
      test(`resolves a ${type} with ${audio ? "separate audio" : "no audio"} from its player manifest`, async () => {
        const { fetch } = fixture({
          html: webPost(type, "https://v.redd.it/clip", player),
          manifest: videoManifest + (audio ? audioManifest : "") + "</Period></MPD>",
        });
        const result = await postfetch(share, { fetch });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({ kind: "video", url: "https://v.redd.it/clip/DASH_480.mp4?a=signature" });
        expect(result.items[0].audio?.url).toBe(audio ? "https://v.redd.it/clip/DASH_AUDIO_128.mp4?a=signature" : undefined);
      });
    }
  }

  test("honors preferred video width on the public page path", async () => {
    const { fetch } = fixture({ html: webPost("video", "https://v.redd.it/clip", player), manifest: videoManifest + "</Period></MPD>" });
    const result = await postfetch(share, { fetch, preferredWidth: 1280 });
    expect(result.items[0].url).toBe("https://v.redd.it/clip/DASH_720.mp4?a=signature");
  });

  test("does not replace a failed video manifest with its poster or an empty text result", async () => {
    const { fetch } = fixture({ html: webPost("video", "https://v.redd.it/clip", player) });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit DASH manifest unavailable");
  });

  test("retains text and paragraph breaks without read-more controls or comment text", async () => {
    const html = webPost("text", canonical, `<div id="t3_${id}-post-rtjson-content"><p>First &amp; second.</p><div><p>Nested paragraph.</p></div></div><button>Read more</button>`)
      + '<shreddit-comment><p>Comment text</p></shreddit-comment>';
    const { fetch } = fixture({ html });
    const result = await postfetch(share, { fetch });
    expect(result.items).toEqual([]);
    expect(result.metadata?.text).toBe("First & second.\n\nNested paragraph.");
  });

  test("preserves the body of image posts as well as their original attachment", async () => {
    const { fetch } = fixture({ html: webPost("image", image, `<div id="t3_${id}-post-rtjson-content"><p>Photo description</p></div>`) });
    const result = await postfetch(share, { fetch });
    expect(result.items[0].url).toBe(image);
    expect(result.metadata?.text).toBe("Photo description");
  });

  test("uses the largest link card rendition and retains its preview role", async () => {
    const small = "https://external-preview.redd.it/card.jpg?width=320&s=small";
    const large = "https://external-preview.redd.it/card.jpg?width=1080&s=large";
    const { fetch } = fixture({ html: webPost("link", "https://github.com/example/project", `<img id="post-image" data-post-media-primary src="${small.replaceAll('&', '&amp;')}" srcset="${small.replaceAll('&', '&amp;')} 320w, ${large.replaceAll('&', '&amp;')} 1080w">`) });
    const result = await postfetch(share, { fetch });
    expect(result.items).toMatchObject([{ url: large, kind: "image", role: "linkPreview" }]);
    expect(result.items).toHaveLength(1);
  });

  test("ignores thumbnail icons on link posts without a primary card", async () => {
    const { fetch } = fixture({ html: webPost("link", "https://github.com/example/project", `<img src="${image}">`) });
    expect((await postfetch(share, { fetch })).items).toEqual([]);
  });

  test("keeps original gallery image order and excludes repeated and comment media", async () => {
    const second = "https://i.redd.it/second.png";
    const link = (url: string) => `<a href="/media?url=${encodeURIComponent(url)}"><img src="https://preview.redd.it/tiny.jpeg"></a>`;
    const { fetch } = fixture({ html: webPost("gallery", canonical, `<gallery-carousel>${link(second)}${link(image)}${link(second)}</gallery-carousel>${link('https://i.redd.it/comment.jpg')}`) });
    const result = await postfetch(share, { fetch });
    expect(result.items.map((item) => item.url)).toEqual([second, image]);
    expect(result.items.map((item) => item.mime)).toEqual(["image/png", "image/jpeg"]);
  });

  test("does not use an incomplete gallery cover as the complete post", async () => {
    const { fetch } = fixture({ html: webPost("gallery", canonical, `<gallery-carousel><a href="${image}">Cover</a></gallery-carousel>`) });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test("recognizes a post's NSFW attribute without matching text in its title", async () => {
    const normal = fixture({ html: page.replace('Haircut &amp; fade', 'nsfw photo &amp; fade') });
    expect((await postfetch(share, { fetch: normal.fetch })).metadata?.nsfw).toBe(false);
    const flagged = fixture({ html: page.replace('<shreddit-post ', '<shreddit-post nsfw ') });
    expect((await postfetch(share, { fetch: flagged.fetch })).metadata?.nsfw).toBe(true);
  });

  test("downloads the RSS root's original photo when the public page is a CAPTCHA", async () => {
    const { fetch, requests } = fixture({
      html: "<title>Reddit - Prove your humanity</title>",
      rss: feed(`<img src="https://preview.redd.it/thumb.jpg"><a href="${image}">[link]</a><a href="${canonical}">[comments]</a>`),
    });
    const result = await postfetch(share, { fetch });
    expect(result.items).toMatchObject([{ url: image, kind: "image" }]);
    expect(result.items).toHaveLength(1);
    expect(result.metadata).toMatchObject({ title: "Feed & post", author: { handle: "Midoriyer" }, createdAt: "2026-11-05T00:03:43.000Z", extra: { subreddit: "teenagers" } });
    expect(result.metadata?.likeCount).toBeUndefined();
    expect(result.metadata?.nsfw).toBeUndefined();
    expect(requests.at(-1)!.url).toBe(`https://www.reddit.com/comments/${id}/.rss?limit=1`);
  });

  test("retains a text post's RSS body without submitted-by boilerplate", async () => {
    const { fetch } = fixture({ html: "Unavailable", rss: feed('<!-- SC_OFF --><div><p>One &amp; two</p><p>Three</p></div><!-- SC_ON --> submitted by reader') });
    const result = await postfetch(share, { fetch });
    expect(result.items).toEqual([]);
    expect(result.metadata?.text).toBe("One & two\n\nThree");
  });

  test("honors the RSS reset window and retries at most once", async () => {
    const { fetch, requests } = fixture({ html: "Unavailable", rss: feed(`<a href="${image}">[link]</a>`), rssReset: "0" });
    expect((await postfetch(share, { fetch })).items[0].url).toBe(image);
    expect(requests.filter((request) => request.url.includes(".rss"))).toHaveLength(2);
  });

  test.each(["999", "-1", "invalid"])("does not wait on an invalid or excessive RSS reset: %s", async (rssReset) => {
    const { fetch, requests } = fixture({ html: "Unavailable", rss: feed(`<a href="${image}">[link]</a>`), rssReset });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
    expect(requests.filter((request) => request.url.includes(".rss"))).toHaveLength(1);
  });

  test.each([
    feed(`<a href="${image}">[link]</a>`, "wrong"),
    feed('<img src="https://preview.redd.it/thumb.jpg">'),
    feed('<a href="https://www.reddit.com/gallery/other">[link]</a>'),
    "<html><title>Blocked</title></html>",
  ])("preserves the failure for unrelated or incomplete RSS %#", async (rss) => {
    const { fetch } = fixture({ html: "Unavailable", rss });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test.each([
    page.replace(`id="t3_${id}"`, 'id="t3_wrong"'),
    page.replace('post-type="image"', 'post-type="gallery"'),
    page.replace('post-type="image"', 'post-type="video"'),
    page.replace(image, "https://preview.redd.it/thumbnail.jpeg"),
    page.replace(image, "javascript:alert(1)"),
    "<title>Prove your humanity</title><form action='/?captcha=1'></form>",
  ])("preserves the API failure for unsupported or unrelated HTML %#", async (html) => {
    const { fetch } = fixture({ html });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test.each([403, 404])("preserves the API failure when the public page returns %s", async (webStatus) => {
    const { fetch } = fixture({ webStatus });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test("does not attempt HTML for a missing API post", async () => {
    const { fetch, requests } = fixture({ apiStatus: 404 });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 404");
    expect(requests).toHaveLength(3);
  });

  test.each([
    challenge.replace('action="/', 'action="https://example.com/'),
    challenge.replace("async e=>e+e", "async e=>doSomething(e)"),
  ])("does not follow an unrecognized or off-site form %#", async (challenge) => {
    const { fetch, requests } = fixture({ challenge });
    await expect(postfetch(share, { fetch })).rejects.toThrow("Reddit post failed: 403");
    expect(requests).toHaveLength(6);
  });
});
