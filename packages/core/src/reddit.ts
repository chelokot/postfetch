import {
  asUrl,
  filename,
  object,
  string,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";

// Logged-out reddit (www/old/api/.json) is fully 403-walled. The public
// installed-app OAuth flow still works: a client id with no secret plus the
// opt-out device id returns a bearer that reads any public post through
// oauth.reddit.com.
const installedClientId = "ohXpoqrZYub1kg";

export async function resolveReddit(input: ResolveContext): Promise<PostfetchResult> {
  const id = await postId(input.net, input.url);
  const token = await appToken(input.net);
  const post = await fetchPost(input.net, token, id);
  const items = mediaItems(post, id);
  if (items.length === 0) {
    throw new Error("Reddit media not found");
  }
  return { archiveFilename: filename(`reddit_${id}.zip`), id, items, platform: "reddit" };
}

// Share and short links (redd.it/<id>, /r/<sub>/s/<share>) carry no post id, so
// they are followed once to read the canonical /comments/<id> location.
async function postId(net: Net, input: string): Promise<string> {
  const direct = parseId(input);
  if (direct) {
    return direct;
  }
  const response = await net(input, { headers: { "user-agent": browserUserAgent() } }, 1);
  const resolved = parseId(response.url);
  if (!resolved) {
    throw new Error("Reddit post id not found");
  }
  return resolved;
}

function parseId(input: string): string | null {
  const url = asUrl(input);
  if (url.hostname === "redd.it") {
    const slug = url.pathname.split("/").filter(Boolean)[0];
    return slug && /^[a-z0-9]+$/i.test(slug) ? slug : null;
  }
  return url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] ?? null;
}

async function appToken(net: Net): Promise<string> {
  const response = await net("https://www.reddit.com/api/v1/access_token", {
    body: "grant_type=https://oauth.reddit.com/grants/installed_client&device_id=DO_NOT_TRACK_THIS_DEVICE",
    headers: {
      authorization: `Basic ${btoa(`${installedClientId}:`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": browserUserAgent(),
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Reddit auth failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const token = object(payload) ? string(payload.access_token) : null;
  if (!token) {
    throw new Error("Reddit token not found");
  }
  return token;
}

async function fetchPost(net: Net, token: string, id: string): Promise<Json> {
  const response = await net(`https://oauth.reddit.com/comments/${id}?raw_json=1&limit=1`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": browserUserAgent() },
  });
  if (!response.ok) {
    throw new Error(`Reddit post failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const listing = Array.isArray(payload) ? payload[0] : null;
  const children = object(listing) && object(listing.data) && Array.isArray(listing.data.children) ? listing.data.children : [];
  const first = children[0];
  const post = object(first) && object(first.data) ? first.data : null;
  if (!post) {
    throw new Error("Reddit post not found");
  }
  return post;
}

function mediaItems(post: Json, id: string): MediaItem[] {
  const own = extract(post, id);
  if (own.length > 0) {
    return own;
  }
  const parents = Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list.filter(object) : [];
  return parents[0] ? extract(parents[0], id) : [];
}

function extract(post: Json, id: string): MediaItem[] {
  const gallery = galleryItems(post, id);
  if (gallery.length > 0) {
    return gallery;
  }
  const video = videoItems(post, id);
  if (video.length > 0) {
    return video;
  }
  return imageItems(post, id);
}

function galleryItems(post: Json, id: string): MediaItem[] {
  const data = object(post.gallery_data) ? post.gallery_data : null;
  const order = data && Array.isArray(data.items) ? data.items.filter(object) : [];
  const metadata = object(post.media_metadata) ? post.media_metadata : {};
  return order.flatMap((entry, index) => {
    const mediaId = string(entry.media_id);
    const meta = mediaId && object(metadata[mediaId]) ? metadata[mediaId] : null;
    const best = meta && object(meta.s) ? meta.s : null;
    if (!best) {
      return [];
    }
    const video = string(best.mp4);
    if (video) {
      return [mediaItem(id, index + 1, "video", "video/mp4", video)];
    }
    const image = string(best.u) ?? string(best.gif);
    return image ? [mediaItem(id, index + 1, "image", mimeOf(string(meta?.m), image), image)] : [];
  });
}

function videoItems(post: Json, id: string): MediaItem[] {
  const media = redditVideo(post);
  const fallback = media ? string(media.fallback_url) : null;
  if (!media || !fallback) {
    return [];
  }
  if (media.has_audio === true) {
    // The fallback stream is video-only; reddit serves audio as a separate DASH
    // rendition, so a complete file needs the muxer. Until then, defer to the
    // fallback downloader rather than return a silent video.
    throw new Error("Reddit video has a separate audio track (muxing required)");
  }
  return [mediaItem(id, null, "video", "video/mp4", fallback)];
}

function redditVideo(post: Json): Json | null {
  const secure = object(post.secure_media) ? post.secure_media : null;
  const media = object(post.media) ? post.media : null;
  const fromSecure = secure && object(secure.reddit_video) ? secure.reddit_video : null;
  const fromMedia = media && object(media.reddit_video) ? media.reddit_video : null;
  return fromSecure ?? fromMedia;
}

function imageItems(post: Json, id: string): MediaItem[] {
  const url = string(post.url_overridden_by_dest) ?? string(post.url);
  if (!url) {
    return [];
  }
  const path = asUrl(url).pathname;
  const isImage = string(post.post_hint) === "image" || asUrl(url).hostname === "i.redd.it" || /\.(jpe?g|png|webp|gif)$/i.test(path);
  return isImage ? [mediaItem(id, null, "image", mimeOf(null, url), url)] : [];
}

function mediaItem(id: string, index: number | null, kind: MediaItem["kind"], mime: string, url: string): MediaItem {
  const suffix = index === null ? "" : `_${index}`;
  return {
    filename: filename(`reddit_${id}${suffix}.${extensionOf(mime)}`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind,
    mime,
    platform: "reddit",
    url,
  };
}

function mimeOf(declared: string | null, url: string): string {
  if (declared && declared.includes("/")) {
    return declared.replace("image/jpg", "image/jpeg");
  }
  const extension = asUrl(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  if (extension === "gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

function extensionOf(mime: string): string {
  if (mime === "video/mp4") {
    return "mp4";
  }
  if (mime === "image/png") {
    return "png";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  if (mime === "image/gif") {
    return "gif";
  }
  return "jpg";
}
