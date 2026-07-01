import { asUrl, count, filename, isoFromEpochSeconds, type PostMetadata, type ResolveContext, type Json, type Net, type PostfetchResult, type MediaItem } from "./internal";
import { browserUserAgent } from "./fingerprint";

export async function resolveFacebook(input: ResolveContext): Promise<PostfetchResult> {
  const canonical = await canonicalUrl(input.net, input.url);
  const id = facebookId(canonical) ?? facebookId(input.url) ?? "video";
  // The embed player only exposes /share/v/ videos; reels (and anything it
  // misses) come from the watch page, which the &_rdr flag serves logged-out.
  const embed = await embedVideo(input.net, canonical);
  const watch = !embed && /^\d+$/.test(id) ? await watchVideo(input.net, id) : null;
  const url = embed ?? watch?.url ?? null;
  if (!url) {
    throw new Error("Facebook video not found");
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
  return { archiveFilename: filename(`facebook_${id}.zip`), id, items: [item], metadata: watch?.metadata, platform: "facebook" };
}

function navigationHeaders(): Record<string, string> {
  return {
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-mode": "navigate",
    "user-agent": browserUserAgent(),
  };
}

// Share and fb.watch links redirect to the canonical /reel/<id> or /<page>/videos/<id>
// URL, which the public embed player needs. We only read the resolved location, not the
// (login-walled) page body.
async function canonicalUrl(net: Net, input: string): Promise<string> {
  const response = await net(input, { headers: navigationHeaders() });
  const resolved = asUrl(response.url);
  return `${resolved.origin}${resolved.pathname}`;
}

// The logged-out watch page is fingerprint-walled, but the public embed player
// (plugins/video.php) still exposes the progressive hd_src/sd_src URLs.
async function embedVideo(net: Net, canonical: string): Promise<string | null> {
  const embed = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}`;
  const response = await net(embed, { headers: navigationHeaders() });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  return source(html, "hd_src") ?? source(html, "sd_src");
}

// The logged-out watch page (with &_rdr) embeds the progressive video URLs in
// its ScheduledServerJS blocks; these are the same fields yt-dlp reads.
async function watchVideo(net: Net, id: string): Promise<{ url: string; metadata: PostMetadata } | null> {
  // Without the document Accept header Facebook serves a JS shell without the
  // media JSON, so ask for HTML explicitly here.
  const headers = { ...navigationHeaders(), accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  const response = await net(`https://www.facebook.com/watch/?v=${id}&_rdr`, { headers });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const url =
    source(html, "playable_url_quality_hd") ??
    source(html, "browser_native_hd_url") ??
    source(html, "playable_url") ??
    source(html, "browser_native_sd_url");
  return url ? { url, metadata: watchMetadata(html) } : null;
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
