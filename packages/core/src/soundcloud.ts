import {
  asUrl,
  count,
  filename,
  isoFromDateString,
  number,
  object,
  string,
  type PostMetadata,
  type SoundcloudExtra,
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
  return { archiveFilename: filename(`soundcloud_${id}.zip`), id, items: [item], metadata: soundcloudMetadata(track), platform: "soundcloud" };
}

export function soundcloudMetadata(track: Json): PostMetadata & { extra?: SoundcloudExtra } {
  const user = object(track.user) ? track.user : null;
  const durationMs = count(track.duration);
  return {
    title: string(track.title) ?? undefined,
    text: string(track.description) ?? undefined,
    author: user
      ? { handle: string(user.username) ?? undefined, name: string(user.full_name) ?? undefined }
      : undefined,
    createdAt: isoFromDateString(track.created_at),
    likeCount: count(track.likes_count),
    commentCount: count(track.comment_count),
    shareCount: count(track.reposts_count),
    viewCount: count(track.playback_count),
    extra: {
      genre: string(track.genre) ?? undefined,
      license: string(track.license) ?? undefined,
      durationSeconds: durationMs === undefined ? undefined : Math.round(durationMs / 1000),
    },
  };
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
  // Prefer the direct progressive mp3; otherwise assemble the AAC HLS playlist
  // (its CMAF segments concatenate into a fragmented mp4) at download time.
  const progressive = transcodings.find((transcoding) => protocol(transcoding) === "progressive");
  const hls = transcodings.find((transcoding) => protocol(transcoding) === "hls" && mimeType(transcoding)?.includes("mp4") === true);
  const chosen = progressive ?? hls;
  if (!chosen) {
    throw new Error("SoundCloud track has no downloadable stream");
  }
  const stream = await streamUrl(net, chosen, clientId);
  const title = string(track.title) ?? id;
  const headers = { "user-agent": browserUserAgent() };
  if (chosen === progressive) {
    return { filename: filename(`soundcloud_${title}.mp3`), headers, id, kind: "audio", mime: "audio/mpeg", platform: "soundcloud", url: stream };
  }
  return { filename: filename(`soundcloud_${title}.m4a`), headers, hls: true, id, kind: "audio", mime: "audio/mp4", platform: "soundcloud", url: stream };
}

async function streamUrl(net: Net, transcoding: Json, clientId: string): Promise<string> {
  const endpoint = string(transcoding.url);
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
  return stream;
}

function protocol(transcoding: Json): string | null {
  const format = object(transcoding.format) ? transcoding.format : null;
  return format ? string(format.protocol) : null;
}

function mimeType(transcoding: Json): string | null {
  const format = object(transcoding.format) ? transcoding.format : null;
  return format ? string(format.mime_type) : null;
}

function trackId(track: Json): string {
  const numeric = number(track.id);
  if (numeric !== null) {
    return String(numeric);
  }
  return string(track.permalink) ?? "track";
}
