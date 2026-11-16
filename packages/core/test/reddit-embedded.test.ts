import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

const reports = [
  { id: "1xxupde", title: "[niri] First time creating a rice without importing a config (llm-assisted)",
    images: ["17e3pai1902i1", "csp0yai1902i1", "sn1daci1902i1", "cfqsjai1902i1", "qdxbiai1902i1", "062ugbi1902i1", "if4ewai1902i1", "ajievai1902i1"], video: "vjxsyav0902i1" },
  { id: "1w08dav", title: "First time ricing Windows 11",
    images: ["erbr3bq7szlh1", "2lyj9lc8szlh1", "6h63plk8szlh1", "1np7q5r8szlh1", "n2usdxx8szlh1", "37s6bn79szlh1", "hxpw0zd9szlh1", "sry9ppj9szlh1"] },
];
const videoManifest = `<MPD><Period><AdaptationSet contentType="video">
  <Representation width="720" bandwidth="100"><BaseURL>CMAF_480.mp4</BaseURL></Representation>
  <Representation width="1080" bandwidth="200"><BaseURL>CMAF_720.mp4</BaseURL></Representation>
</AdaptationSet>`;
const audioManifest = `<AdaptationSet contentType="audio"><Representation bandwidth="128000"><BaseURL>AUDIO.mp4</BaseURL></Representation></AdaptationSet>`;

function fixture(id: string, html: string, manifest = videoManifest + "</Period></MPD>") {
  const requests: string[] = [];
  const fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/access_token")) return Response.json({ access_token: "test-token" });
    if (url.startsWith("https://oauth.reddit.com/")) return new Response(null, { status: 403 });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (url === `https://www.reddit.com/comments/${id}?embedded=true`) return new Response(html);
    if (url === `https://www.reddit.com/comments/${id}/`) return new Response("<title>Reddit - Prove your humanity</title>");
    if (url.startsWith("https://v.redd.it/")) return new Response(manifest);
    if (url.endsWith("/.rss?limit=1")) return new Response(null, { status: 403 });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function captured(id: string) {
  // Root post markup captured from the reported URLs; page chrome and scripts
  // are excluded. These include gallery tiles, full-size links and body text.
  return Bun.file(new URL(`./fixtures/reddit/${id}.html`, import.meta.url)).text();
}

describe("Reddit embedded gallery fallback", () => {
  for (const report of reports) {
    test(`recovers the complete reported gallery ${report.id} after OAuth 403 and a public CAPTCHA`, async () => {
      const { fetch, requests } = fixture(report.id, await captured(report.id));
      const result = await postfetch(`https://www.reddit.com/comments/${report.id}/`, { fetch });
      expect(result.metadata?.title).toBe(report.title);
      expect(result.metadata?.text).toBeTruthy();
      expect(result.items.map((item) => item.url)).toEqual([
        ...report.images.map((image) => `https://i.redd.it/${image}.png`),
        ...(report.video ? [`https://v.redd.it/${report.video}/CMAF_480.mp4`] : []),
      ]);
      expect(result.items.map((item) => item.filename)).toEqual(result.items.map((item, index) => `reddit_${report.id}_${index + 1}.${item.kind === "video" ? "mp4" : "png"}`));
      expect(result.items.every((item) => item.id === report.id && !item.role)).toBe(true);
      expect(result.items.at(-1)?.audio).toBeUndefined();
      expect(result.metadata?.text).not.toContain("/player");
      expect(requests.some((url) => url.includes(".rss"))).toBe(false);
      expect(result.metadata).toMatchObject(report.video
        ? { author: { handle: "emanresu-gnirob" }, createdAt: "2026-11-16T17:00:52.000Z", commentCount: 15, nsfw: false }
        : { author: { handle: "Efficient-Hawk3568" }, createdAt: "2026-08-27T22:17:27.000Z", commentCount: 21, nsfw: false });
    });
  }

  test("uses gallery order for mixed media, selects preferred video width and keeps audio", async () => {
    const report = reports[0]!;
    const html = (await captured(report.id)).replace(
      `data-media-ids="${report.images.join(",")},${report.video}"`,
      `data-media-ids="${report.video},${report.images.join(",")}"`,
    ).replace(/data-position="(\d+)"/g, (_, n: string) => `data-position="${Number(n) + 1}"`);
    const { fetch } = fixture(report.id, html, videoManifest + audioManifest + "</Period></MPD>");
    const result = await postfetch(`https://www.reddit.com/comments/${report.id}/`, { fetch, preferredWidth: 1080 });
    expect(result.items[0]).toMatchObject({ kind: "video", filename: `reddit_${report.id}_1.mp4`, url: `https://v.redd.it/${report.video}/CMAF_720.mp4`, audio: { url: `https://v.redd.it/${report.video}/AUDIO.mp4` } });
    expect(result.items[1]).toMatchObject({ kind: "image", filename: `reddit_${report.id}_2.png`, url: `https://i.redd.it/${report.images[0]}.png` });
    expect(result.items).toHaveLength(9);
  });

  test("does not include images or video links outside the root post", async () => {
    const report = reports[1]!;
    const html = '<div data-fullname="t1_comment"><a class="gallery-item-thumbnail-link" data-position="1" href="https://preview.redd.it/comment.png">comment</a></div>'
      + await captured(report.id) + '<div><a href="https://reddit.com/link/1w08dav/video/comment/player">comment</a></div>';
    const { fetch } = fixture(report.id, html);
    const result = await postfetch(`https://www.reddit.com/comments/${report.id}/`, { fetch });
    expect(result.items).toHaveLength(8);
    expect(result.items.every((item) => !item.url.includes("comment"))).toBe(true);
  });

  test.each(["missing-image", "missing-video", "wrong-post", "wrong-image", "external-image", "duplicate-id", "truncated"])("rejects an incomplete or unrelated gallery: %s", async (failure) => {
    const report = reports[0]!;
    let html = await captured(report.id);
    if (failure === "missing-image") html = html.replace('data-position="8"', 'data-position="99"');
    if (failure === "missing-video") html = html.replaceAll(`/video/${report.video}/player`, "/video/wrong/player");
    if (failure === "wrong-post") html = html.replace(`id="thing_t3_${report.id}"`, 'id="thing_t3_other"');
    if (failure === "wrong-image") html = html.replace(/(href="https:\/\/preview.redd.it\/)17e3pai1902i1/g, "$1wrong");
    if (failure === "external-image") html = html.replace(/href="https:\/\/preview.redd.it\//g, 'href="https://example.com/');
    if (failure === "duplicate-id") html = html.replace('data-media-ids="', `data-media-ids="${report.video},`);
    if (failure === "truncated") html = html.slice(0, html.lastIndexOf("</div>"));
    const { fetch } = fixture(report.id, html);
    await expect(postfetch(`https://www.reddit.com/comments/${report.id}/`, { fetch })).rejects.toThrow("Reddit post failed: 403");
  });

  test("fails a mixed gallery if its video manifest cannot be resolved", async () => {
    const report = reports[0]!;
    const { fetch } = fixture(report.id, await captured(report.id), "Invalid manifest");
    await expect(postfetch(`https://www.reddit.com/comments/${report.id}/`, { fetch })).rejects.toThrow("Reddit DASH manifest unavailable");
  });
});
