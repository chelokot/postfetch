import {
  asUrl,
  filename,
  number,
  object,
  string,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";

export async function resolveSoundcloud(input: ResolveContext): Promise<PostfetchResult> {
  const url = await canonicalUrl(input.net, input.url);
  const clientId = await appClientId(input.net);
  const track = await resolveTrack(input.net, url, clientId);
  const id = trackId(track);
  const item = await audioItem(input.net, track, id, clientId);
  return { archiveFilename: filename(`soundcloud_${id}.zip`), id, items: [item], platform: "soundcloud" };
}

async function canonicalUrl(net: Net, input: string): Promise<string> {
  const host = asUrl(input).hostname;
  if (host !== "on.soundcloud.com" && host !== "snd.sc") {
    return input;
  }
  const response = await net(input, { headers: { "user-agent": browserUserAgent() } }, 1);
  return response.url;
}

// SoundCloud's public api-v2 needs a client_id, which the web app ships inside one
// of its asset bundles. The bundle that carries it changes, so the script srcs are
// scanned (newest first) until one yields the token.
async function appClientId(net: Net): Promise<string> {
  const home = await net("https://soundcloud.com/", { headers: { "user-agent": browserUserAgent() } });
  if (!home.ok) {
    throw new Error(`SoundCloud home failed: ${home.status}`);
  }
  const html = await home.text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
  for (const src of scripts.reverse()) {
    const response = await net(src, { headers: { "user-agent": browserUserAgent() } }, 1);
    if (!response.ok) {
      continue;
    }
    const code = await response.text();
    const id = code.match(/client_id\s*[:=]\s*"([A-Za-z0-9]{20,})"/)?.[1];
    if (id) {
      return id;
    }
  }
  throw new Error("SoundCloud client id not found");
}

async function resolveTrack(net: Net, url: string, clientId: string): Promise<Json> {
  const api = new URL("https://api-v2.soundcloud.com/resolve");
  api.searchParams.set("url", url);
  api.searchParams.set("client_id", clientId);
  const response = await net(api.href, { headers: { accept: "application/json", "user-agent": browserUserAgent() } });
  if (!response.ok) {
    throw new Error(`SoundCloud resolve failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  if (!object(payload) || string(payload.kind) !== "track") {
    throw new Error("SoundCloud track not found");
  }
  return payload;
}

async function audioItem(net: Net, track: Json, id: string, clientId: string): Promise<MediaItem> {
  const media = object(track.media) ? track.media : null;
  const transcodings = media && Array.isArray(media.transcodings) ? media.transcodings.filter(object) : [];
  const progressive = transcodings.find((transcoding) => protocol(transcoding) === "progressive");
  if (!progressive) {
    // Some tracks expose only HLS renditions; a single file needs the segment
    // demuxer rather than a direct progressive stream.
    throw new Error("SoundCloud track is HLS-only (muxing required)");
  }
  const endpoint = string(progressive.url);
  if (!endpoint) {
    throw new Error("SoundCloud stream endpoint not found");
  }
  const url = new URL(endpoint);
  url.searchParams.set("client_id", clientId);
  const response = await net(url.href, { headers: { accept: "application/json", "user-agent": browserUserAgent() } });
  if (!response.ok) {
    throw new Error(`SoundCloud stream failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const stream = object(payload) ? string(payload.url) : null;
  if (!stream) {
    throw new Error("SoundCloud stream url not found");
  }
  const title = string(track.title) ?? id;
  return {
    filename: filename(`soundcloud_${title}.mp3`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind: "audio",
    mime: "audio/mpeg",
    platform: "soundcloud",
    url: stream,
  };
}

function protocol(transcoding: Json): string | null {
  const format = object(transcoding.format) ? transcoding.format : null;
  return format ? string(format.protocol) : null;
}

function trackId(track: Json): string {
  const numeric = number(track.id);
  if (numeric !== null) {
    return String(numeric);
  }
  return string(track.permalink) ?? "track";
}
