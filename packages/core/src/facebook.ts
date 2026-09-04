import { asUrl, count, filename, isoFromEpochSeconds, PostfetchError, type PostMetadata, type ResolveContext, type Json, type Net, type PostfetchResult, type MediaItem } from "./internal";
import { browserUserAgent } from "./fingerprint";

export async function resolveFacebook(input: ResolveContext): Promise<PostfetchResult> {
  const page = await canonicalPage(input.net, normalizedInputUrl(input.url));
  const canonical = page.url;
  const id = facebookId(canonical) ?? facebookId(input.url) ?? "video";
  const pageMetadata = facebookMetadata(page.html);
  // The embed player only exposes /share/v/ videos; reels (and anything it
  // misses) come from the watch page, which the &_rdr flag serves logged-out.
  const embed = await embedVideo(input.net, canonical, input.preferredWidth);
  const watch = !embed && /^\d+$/.test(id) ? await watchVideo(input.net, id, input.preferredWidth) : null;
  const url = embed ?? watch?.url ?? null;
  if (!url) {
    // As with Reddit and X, a public text post is a valid result even when it
    // has no downloadable media. Require post metadata from the canonical page
    // so a missing or login-walled video does not become a false success.
    if (pageMetadata?.text) {
      return { archiveFilename: filename(`facebook_${id}.zip`), id, items: [], metadata: pageMetadata, platform: "facebook" };
    }
    throw new PostfetchError(404, "Facebook video not found", "notFound");
  }
  const item: MediaItem = {
    filename: filename(`facebook_${id}.mp4`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "facebook",
    url,
  };
  return {
    archiveFilename: filename(`facebook_${id}.zip`),
    id,
    items: [item],
    metadata: mergeMetadata(pageMetadata, watch?.metadata),
    platform: "facebook",
  };
}

// Facebook share links are opaque shortlinks. Messaging apps sometimes append
// selected text to the copied URL as another path segment; Facebook returns 404
// for that form even though the share token is still intact. Strip everything
// after the token before following the redirect.
function normalizedInputUrl(input: string): string {
  const url = asUrl(input);
  const share = url.pathname.match(/^\/share\/([a-z])\/([A-Za-z0-9]+)/i);
  return share ? `${url.origin}/share/${share[1]}/${share[2]}/` : input;
}

function navigationHeaders(): Record<string, string> {
  return {
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-mode": "navigate",
    "user-agent": browserUserAgent(),
  };
}

// Share and fb.watch links redirect to the canonical /reel/<id> or /<page>/videos/<id>
// URL, which the public embed player needs. Public post pages also carry Open
// Graph metadata in their logged-out HTML, so retain the body after redirecting.
async function canonicalPage(net: Net, input: string): Promise<{ html: string; url: string }> {
  const response = await net(input, { headers: navigationHeaders() });
  const resolved = asUrl(response.url || input);
  return {
    html: response.ok ? await response.text() : "",
    url: `${resolved.origin}${resolved.pathname}`,
  };
}

// The logged-out watch page is fingerprint-walled, but the public embed player
// (plugins/video.php) still exposes the progressive hd_src/sd_src URLs.
async function embedVideo(net: Net, canonical: string, preferredWidth: number): Promise<string | null> {
  const embed = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}`;
  const response = await net(embed, { headers: navigationHeaders() });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  return preferredSource(preferredWidth, source(html, "hd_src"), source(html, "sd_src"));
}

// The logged-out watch page (with &_rdr) embeds the progressive video URLs in
// its ScheduledServerJS blocks; these are the same fields yt-dlp reads.
async function watchVideo(net: Net, id: string, preferredWidth: number): Promise<{ url: string; metadata: PostMetadata } | null> {
  // Without the document Accept header Facebook serves a JS shell without the
  // media JSON, so ask for HTML explicitly here.
  const headers = { ...navigationHeaders(), accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  const response = await net(`https://www.facebook.com/watch/?v=${id}&_rdr`, { headers });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const hd = source(html, "playable_url_quality_hd") ?? source(html, "browser_native_hd_url");
  const sd = source(html, "playable_url") ?? source(html, "browser_native_sd_url");
  const url = preferredSource(preferredWidth, hd, sd);
  return url ? { url, metadata: watchMetadata(html) } : null;
}

// Facebook labels its two progressive renditions as 720p HD and 360p SD. Pick
// the one closest to the requested width, preferring HD on the 540px midpoint.
function preferredSource(preferredWidth: number, hd: string | null, sd: string | null): string | null {
  return preferredWidth >= 540 ? hd ?? sd : sd ?? hd;
}

// Only the fields that can be read unambiguously from the flat page: the
// caption (creation_story) and the reaction/comment/share counts appear in
// shapes shared with related videos and comment threads, so they are skipped
// rather than risk attributing the wrong value.
function watchMetadata(html: string): PostMetadata {
  const owner = html.match(/"name":("(?:\\.|[^"\\])*"),"__isVideoOwner"/);
  const name = owner ? (JSON.parse(owner[1]) as string) : undefined;
  return {
    author: name ? { name } : undefined,
    createdAt: isoFromEpochSeconds(html.match(/"publish_time":(\d+)/)?.[1]),
    viewCount: count(html.match(/"video_view_count":(\d+)/)?.[1]),
  };
}

// Public post pages expose their caption and page/profile name as Open Graph
// metadata even when there is no media player. Facebook truncates long captions
// there, but it is still enough to identify and represent a text post.
function facebookMetadata(html: string): PostMetadata | undefined {
  const canonical = metaContent(html, "og:url");
  if (!canonical || !facebookPostUrl(canonical)) {
    return undefined;
  }
  const text = metaContent(html, "og:description") ?? metaContent(html, "description");
  const name = metaContent(html, "og:title");
  if (!text && !name) {
    return undefined;
  }
  return {
    text: text ?? undefined,
    author: name ? { name } : undefined,
  };
}

function facebookPostUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      /\/posts\/(?:[^/]+\/)?[A-Za-z0-9]+\/?$/.test(url.pathname) ||
      /\/share\/p\/[A-Za-z0-9]+\/?$/.test(url.pathname) ||
      ((url.pathname === "/permalink.php" || url.pathname === "/story.php") && Boolean(url.searchParams.get("story_fbid")))
    );
  } catch {
    return false;
  }
}

function metaContent(html: string, key: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if ((attribute(tag, "property") ?? attribute(tag, "name")) !== key) {
      continue;
    }
    const content = attribute(tag, "content");
    return content ? decodeHtml(content) : null;
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "is"));
  return match?.[2] ?? null;
}

function decodeHtml(input: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return input.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
    if (code[0] !== "#") {
      return named[code.toLowerCase()] ?? entity;
    }
    const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isSafeInteger(value) && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
  });
}

function mergeMetadata(page: PostMetadata | undefined, watch: PostMetadata | undefined): PostMetadata | undefined {
  if (!page) {
    return watch;
  }
  if (!watch) {
    return page;
  }
  return { ...page, ...watch, author: watch.author ?? page.author };
}

function source(html: string, key: string): string | null {
  const match = html.match(new RegExp(`"${key}":("(?:\\\\.|[^"\\\\])*")`));
  if (!match) {
    return null;
  }
  const decoded: Json | string | null = JSON.parse(match[1]);
  return typeof decoded === "string" && decoded.length > 0 ? decoded : null;
}

function facebookId(input: string): string | null {
  const url = asUrl(input);
  const fromQuery = url.searchParams.get("v");
  if (fromQuery && /^\d+$/.test(fromQuery)) {
    return fromQuery;
  }
  const numeric = url.pathname.match(/\/(?:reel|videos?|watch)\/(\d+)/);
  if (numeric) {
    return numeric[1];
  }
  const token = url.pathname.match(/\/(?:share\/[a-z]\/|posts\/|videos\/)?([A-Za-z0-9]+)\/?$/);
  return token ? token[1] : null;
}
