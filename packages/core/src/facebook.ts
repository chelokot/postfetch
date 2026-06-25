import { asUrl, filename, type ResolveContext, type Json, type Net, type PostfetchResult, type MediaItem } from "./internal";
import { browserUserAgent } from "./fingerprint";

export async function resolveFacebook(input: ResolveContext): Promise<PostfetchResult> {
  const canonical = await canonicalUrl(input.net, input.url);
  const id = facebookId(canonical) ?? facebookId(input.url) ?? "video";
  const url = await embedVideo(input.net, canonical);
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
  return { archiveFilename: filename(`facebook_${id}.zip`), id, items: [item], platform: "facebook" };
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
