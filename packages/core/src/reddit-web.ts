import { browserUserAgent } from "./fingerprint";
import type { Json, Net } from "./internal";

export type RedditPage = { url: string; html: string; userAgent: string; cookies: string[]; ok: boolean };

export async function readWebPage(response: Response, userAgent: string): Promise<RedditPage> {
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]!);
  if (!response.ok) {
    await response.body?.cancel();
    return { url: response.url, html: "", userAgent, cookies, ok: false };
  }
  return { url: response.url, html: await response.text(), userAgent, cookies, ok: true };
}

export async function fetchWebPage(net: Net, input: string, userAgent: string, cookies: string[] = []): Promise<RedditPage> {
  let url = new URL(input);
  let jar = new Map(cookies.map((cookie) => [cookie.split("=", 1)[0]!, cookie]));
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (url.protocol !== "https:" || !/^(?:(?:www\.|old\.|m\.)?reddit\.com|redd\.it)$/.test(url.hostname)) throw new Error("Invalid Reddit page redirect");
    const headers = { "user-agent": userAgent, ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}) };
    // fetch does not keep Set-Cookie values while automatically following a
    // redirect. Reddit's successful JS check redirects after setting its token.
    const response = await net(url.href, { headers, redirect: "manual" }, 1);
    for (const cookie of response.headers.getSetCookie()) {
      const value = cookie.split(";", 1)[0]!;
      const name = value.split("=", 1)[0]!;
      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      const target = new URL(location, url);
      if (target.origin !== url.origin) jar = new Map();
      url = target;
      continue;
    }
    return { ...await readWebPage(response, userAgent), url: response.url || url.href, cookies: [...jar.values()] };
  }
  throw new Error("Too many Reddit page redirects");
}

// Read only the requested post, never thumbnails or attachments from comments
// and recommendations. Return Reddit's normal JSON shape to reuse extraction.
export async function fetchWebPost(net: Net, id: string, input: string, initial?: RedditPage): Promise<Json | null> {
  const url = new URL(input);
  if (url.protocol !== "https:" || !/^(?:(?:www\.|old\.|m\.)?reddit\.com|redd\.it)$/.test(url.hostname)) return null;
  if (url.hostname !== "redd.it") url.hostname = "www.reddit.com";
  const userAgent = initial?.userAgent ?? browserUserAgent();
  let page = initial ?? await fetchWebPage(net, url.href, userAgent);
  if (!page.ok) return null;
  const challenge = challengeUrl(page.html, page.url);
  if (challenge) {
    page = await fetchWebPage(net, challenge, userAgent, page.cookies);
    if (!page.ok) return null;
  }
  for (const match of page.html.matchAll(/<shreddit-post\s([^>]+)>([\s\S]*?)<\/shreddit-post>/gi)) {
    const post = attributes(match[1]);
    if (post.id !== `t3_${id}` || !post["post-title"]) continue;
    const media = postMedia(post, match[2], id);
    if (!media) return null;
    const created = Date.parse(post["created-timestamp"] ?? "");
    return {
      ...media,
      id,
      title: post["post-title"],
      selftext: postText(match[2], id),
      author: post.author,
      subreddit: post["subreddit-name"],
      permalink: post.permalink,
      created_utc: Number.isFinite(created) ? Math.floor(created / 1000) : undefined,
      ups: finiteNumber(post.score),
      score: finiteNumber(post.score),
      upvote_ratio: finiteNumber(post["upvote-ratio"]),
      num_comments: finiteNumber(post["comment-count"]),
      over_18: Object.hasOwn(post, "nsfw"),
    };
  }
  return null;
}

// The public Atom feed remains usable on some routes that reject OAuth and
// browser pages. Match the root entry explicitly: replies have their own media.
export async function fetchRssPost(net: Net, id: string): Promise<Json | null> {
  const url = `https://www.reddit.com/comments/${id}/.rss?limit=1`;
  const headers = { "user-agent": browserUserAgent(), accept: "application/atom+xml" };
  let response = await net(url, { headers }, 1);
  if (response.status === 429) {
    // Reddit currently advertises a small anonymous RSS quota and its reset
    // window in this header, rather than Retry-After. Retry once within a bound.
    const reset = finiteNumber(response.headers.get("x-ratelimit-reset") ?? undefined);
    await response.body?.cancel();
    if (reset === undefined || reset < 0 || reset > 15) return null;
    await new Promise((resolve) => setTimeout(resolve, (reset + 0.1) * 1000));
    response = await net(url, { headers }, 1);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const xml = await response.text();
  if (!/<feed\b/.test(xml)) return null;
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    if (entry.match(/<id>([^<]+)<\/id>/)?.[1] !== `t3_${id}`) continue;
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const content = decodeHtml(entry.match(/<content\b[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "");
    const link = [...content.matchAll(/<a\s([^>]+)>\s*\[link\]\s*<\/a>/g)][0];
    const destination = link ? attributes(link[1]).href : undefined;
    const image = hostedImage(destination);
    let media: Json | null = image ? { post_hint: "image", url: image } : null;
    if (!media && destination) {
      const target = new URL(destination);
      if (target.protocol === "https:" && target.hostname === "v.redd.it" && /^\/[a-z0-9]+\/?$/i.test(target.pathname)) {
        media = { secure_media: { reddit_video: { dash_url: target.href.replace(/\/$/, "") + "/DASHPlaylist.mpd" } } };
      } else if (/^https?:$/.test(target.protocol) && !/(^|\.)(reddit\.com|redd\.it)$/.test(target.hostname)) {
        const card = content.match(/<img\s([^>]+)>/);
        const preview = card ? attributes(card[1]).src : undefined;
        const previewUrl = preview ? new URL(preview) : null;
        media = {
          post_hint: "link", is_self: false, url: target.href,
          ...(previewUrl?.protocol === "https:" && previewUrl.hostname === "external-preview.redd.it"
            ? { preview: { images: [{ source: { url: previewUrl.href } }] } } : {}),
        };
      }
    }
    const body = content.match(/<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/)?.[1];
    if (!media && !destination && body) media = { is_self: true };
    if (!title || !media) return null;
    const permalink = [...entry.matchAll(/<link\s([^>]+)\/?\s*>/g)]
      .map((match) => attributes(match[1]).href).find((href) => href?.includes(`/comments/${id}/`));
    const created = Date.parse(entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? "");
    return {
      ...media, id, title: decodeHtml(title), selftext: body ? plainText(body) : undefined,
      author: decodeHtml(entry.match(/<name>([^<]+)<\/name>/)?.[1] ?? "").replace(/^\/u\//, "") || undefined,
      subreddit: attributes(entry.match(/<category\s([^>]+)>/)?.[1] ?? "").term,
      permalink: permalink ? new URL(permalink).pathname : undefined,
      created_utc: Number.isFinite(created) ? Math.floor(created / 1000) : undefined,
    };
  }
  return null;
}

function postMedia(post: Record<string, string>, html: string, id: string): Json | null {
  if (post["post-type"] === "text") return { is_self: true };
  if (post["post-type"] === "image") {
    const url = hostedImage(post["content-href"]);
    return url ? { post_hint: "image", url } : null;
  }
  if (post["post-type"] === "gallery") {
    const gallery = html.match(/<(gallery-carousel|shreddit-gallery)\b[^>]*>([\s\S]*?)<\/\1>/i);
    if (!gallery) return null;
    const images: string[] = [];
    for (const match of gallery[2].matchAll(/<a\s([^>]+)>/gi)) {
      const href = attributes(match[1]).href;
      if (!href) continue;
      const target = new URL(href, "https://www.reddit.com");
      const media = target.origin === "https://www.reddit.com" && target.pathname === "/media"
        ? target.searchParams.get("url") : target.hostname === "i.redd.it" ? target.href : null;
      if (!media) continue;
      const original = hostedImage(media);
      if (!original) return null;
      if (!images.includes(original)) images.push(original);
    }
    // A gallery cover alone is insufficient evidence of the complete post.
    if (images.length < 2) return null;
    return {
      gallery_data: { items: images.map((_, index) => ({ media_id: String(index) })) },
      media_metadata: Object.fromEntries(images.map((url, index) => [String(index), { s: { u: url } }])),
    };
  }
  if (post["post-type"] === "link") {
    const url = new URL(post["content-href"] ?? "", "https://www.reddit.com");
    if (!/^https?:$/.test(url.protocol) || /(^|\.)(reddit\.com|redd\.it)$/.test(url.hostname)) return null;
    const preview = linkPreview(html);
    return {
      post_hint: "link", is_self: false, url: url.href,
      ...(preview ? { preview: { images: [{ source: { url: preview } }] } } : {}),
    };
  }
  if (post["post-type"] === "video" || post["post-type"] === "gif") {
    const destination = new URL(post["content-href"] ?? "", "https://www.reddit.com");
    if (destination.protocol !== "https:" || destination.hostname !== "v.redd.it" || !/^\/[a-z0-9]+\/?$/i.test(destination.pathname)) return null;
    for (const match of html.matchAll(/<shreddit-player\s([^>]+)>/gi)) {
      const player = attributes(match[1]);
      if (player["post-id"] !== `t3_${id}` || player["media-placement"] === "comment") continue;
      const playlist = new URL(player.src ?? "", destination);
      const base = destination.href.replace(/\/$/, "") + "/";
      if (playlist.origin !== destination.origin || !playlist.href.startsWith(base) || !/\/(?:HLSPlaylist\.m3u8|DASHPlaylist\.mpd)$/.test(playlist.pathname)) continue;
      const dash = new URL("DASHPlaylist.mpd", base);
      dash.search = playlist.search;
      return { secure_media: { reddit_video: { dash_url: dash.href } } };
    }
  }
  return null;
}

function linkPreview(html: string): string | null {
  for (const match of html.matchAll(/<img\s([^>]+)>/gi)) {
    const image = attributes(match[1]);
    if (image.id !== "post-image" || !Object.hasOwn(image, "data-post-media-primary")) continue;
    const sources = (image.srcset ?? "").split(/,\s*/).flatMap((source) => {
      const match = source.trim().match(/^(\S+)\s+(\d+)w$/);
      return match ? [{ url: match[1], width: Number(match[2]) }] : [];
    });
    if (image.src) sources.push({ url: image.src, width: finiteNumber(image.width) ?? 0 });
    for (const source of sources.sort((a, b) => b.width - a.width)) {
      const url = new URL(source.url, "https://www.reddit.com");
      if (url.protocol === "https:" && /^(?:external-preview|preview)\.redd\.it$/.test(url.hostname)) return url.href;
    }
  }
  return null;
}

function hostedImage(input: string | undefined): string | null {
  if (!input) return null;
  const url = new URL(input, "https://www.reddit.com");
  return url.protocol === "https:" && url.hostname === "i.redd.it" && /\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname) ? url.href : null;
}

function postText(html: string, id: string): string | undefined {
  for (const match of html.matchAll(/<div\s([^>]+)>/gi)) {
    const attrs = attributes(match[1]);
    if (attrs.id !== `t3_${id}-post-rtjson-content`) continue;
    const start = match.index + match[0].length;
    const tags = /<div\b[^>]*>|<\/div\s*>/gi;
    tags.lastIndex = start;
    let depth = 1;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return plainText(html.slice(start, tag.index));
    }
  }
  return undefined;
}

function plainText(html: string): string {
  return decodeHtml(html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|li|blockquote|pre|h[1-6])\b[^>]*>|<br\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, ""))
    .replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function finiteNumber(value: string | undefined): number | undefined {
  const number = value === undefined ? NaN : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

// Reddit sometimes serves a tiny form before the public page. Recognize only
// its fixed string-doubling script; never evaluate JavaScript from the page.
function challengeUrl(html: string, responseUrl: string): string | null {
  const seed = html.match(/await\s*\(async\s+([a-z])\s*=>\s*\1\s*\+\s*\1\)\("([a-f0-9]{16})"\)/i)?.[2];
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!seed || !form || !responseUrl) return null;
  const fields = attributes(form[1]);
  if (fields.method?.toUpperCase() !== "GET" || !fields.action) return null;
  const base = new URL(responseUrl);
  const target = new URL(fields.action, base);
  if (base.origin !== "https://www.reddit.com" || target.origin !== base.origin || target.pathname !== base.pathname) return null;
  const inputs = new Map<string, string>();
  for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = attributes(input[1]);
    if (attrs.name) inputs.set(attrs.name, attrs.value ?? "");
  }
  if (inputs.get("js_challenge") !== "1" || !inputs.get("jsc_token") || !inputs.has("solution")) return null;
  target.search = "";
  for (const [key, value] of inputs) {
    if (["solution", "js_challenge", "jsc_token", "jsc_orig_r"].includes(key)) target.searchParams.append(key, key === "solution" ? seed + seed : value);
  }
  for (const [key, value] of base.searchParams) {
    if (!inputs.has(key)) target.searchParams.append(key, value);
  }
  return target.href;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/(?:^|\s)([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function decodeHtml(input: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return input.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
    if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
    const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isSafeInteger(value) && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
  });
}
