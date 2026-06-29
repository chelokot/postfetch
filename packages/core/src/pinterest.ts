import {
  asUrl,
  count,
  filename,
  isoFromDateString,
  number,
  object,
  string,
  type PinterestExtra,
  type PostMetadata,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";
import { isMasterPlaylist, parseMaster, type HlsVariant } from "./hls";

export async function resolvePinterest(input: ResolveContext): Promise<PostfetchResult> {
  const id = await pinId(input.net, input.url);
  const pin = await pinResource(input.net, id);
  const items = await mediaItems(input, pin, id);
  if (items.length === 0) {
    throw new Error("Pinterest media not found");
  }
  return { archiveFilename: filename(`pinterest_${id}.zip`), id, items, metadata: pinterestMetadata(pin), platform: "pinterest" };
}

export function pinterestMetadata(pin: Json): PostMetadata & { extra?: PinterestExtra } {
  const pinner = object(pin.pinner) ? pin.pinner : null;
  const reactions = object(pin.reaction_counts)
    ? Object.values(pin.reaction_counts).reduce<number>((sum, value) => sum + (count(value) ?? 0), 0)
    : undefined;
  return {
    title: (string(pin.title) ?? string(pin.grid_title)) ?? undefined,
    text: string(pin.description) ?? undefined,
    author: pinner
      ? { handle: string(pinner.username) ?? undefined, name: string(pinner.full_name) ?? undefined }
      : undefined,
    createdAt: isoFromDateString(pin.created_at),
    likeCount: reactions,
    commentCount: count(pin.comment_count),
    extra: {
      saveCount: count(pin.repin_count),
      dominantColor: string(pin.dominant_color) ?? undefined,
      outboundLink: string(pin.link) ?? undefined,
    },
  };
}

// pin.it short links carry no pin id, so they are followed once to the canonical
// /pin/<id>/ location.
async function pinId(net: Net, input: string): Promise<string> {
  const direct = parsePin(input);
  if (direct) {
    return direct;
  }
  const response = await net(input, { headers: { "user-agent": browserUserAgent() } }, 1);
  const resolved = parsePin(response.url);
  if (!resolved) {
    throw new Error("Pinterest pin id not found");
  }
  return resolved;
}

function parsePin(input: string): string | null {
  return asUrl(input).pathname.match(/\/pin\/(\d+)/)?.[1] ?? null;
}

// Logged out, the pin page no longer carries the pin data; the public PinResource
// endpoint returns it as JSON for any handler-tagged request, no cookie needed.
async function pinResource(net: Net, id: string): Promise<Json> {
  const data = JSON.stringify({
    options: { id, field_set_key: "unauth_react_main_pin", fetch_visual_search_objects: false },
    context: {},
  });
  const url = new URL("https://www.pinterest.com/resource/PinResource/get/");
  url.searchParams.set("source_url", `/pin/${id}/`);
  url.searchParams.set("data", data);
  const response = await net(url.href, {
    headers: {
      accept: "application/json",
      "user-agent": browserUserAgent(),
      "x-pinterest-pws-handler": "www/pin/[id].js",
    },
  });
  if (!response.ok) {
    throw new Error(`Pinterest resource failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const wrapper = object(payload) && object(payload.resource_response) ? payload.resource_response : null;
  const pin = wrapper && object(wrapper.data) ? wrapper.data : null;
  if (!pin) {
    throw new Error("Pinterest pin not found");
  }
  return pin;
}

async function mediaItems(input: ResolveContext, pin: Json, id: string): Promise<MediaItem[]> {
  const video = await standardVideo(input, pin, id);
  if (video.length > 0) {
    return video;
  }
  const story = await storyItems(input, pin, id);
  if (story.length > 0) {
    return story;
  }
  return imageItems(pin, id);
}

async function standardVideo(input: ResolveContext, pin: Json, id: string): Promise<MediaItem[]> {
  const item = await videoFromList(input, id, null, videoList(object(pin.videos) ? pin.videos : null));
  return item ? [item] : [];
}

// Idea pins carry their media as story blocks, usually as HLS rather than a
// progressive file. Each video block is resolved to its best rendition; only a
// block with neither a progressive nor an HLS stream is treated as undownloadable.
async function storyItems(input: ResolveContext, pin: Json, id: string): Promise<MediaItem[]> {
  const story = object(pin.story_pin_data) ? pin.story_pin_data : null;
  if (!story) {
    return [];
  }
  const pages = Array.isArray(story.pages) ? story.pages.filter(object) : [];
  const blocks = pages.flatMap((page) => (Array.isArray(page.blocks) ? page.blocks.filter(object) : []));
  const videoBlocks = blocks.filter((block) => object(block.video));
  const videos: MediaItem[] = [];
  for (const [index, block] of videoBlocks.entries()) {
    const item = await videoFromList(input, id, index + 1, videoList(object(block.video) ? block.video : null));
    if (item) {
      videos.push(item);
    }
  }
  if (videos.length > 0) {
    return videos;
  }
  if (videoBlocks.length > 0) {
    throw new Error("Pinterest idea pin video has no downloadable rendition");
  }
  return imageItems(pin, id);
}

// Prefer a progressive mp4; fall back to the HLS master, picking the variant
// nearest the preferred width and pairing it with its audio group.
async function videoFromList(input: ResolveContext, id: string, index: number | null, renditions: Json[]): Promise<MediaItem | null> {
  const progressive = progressiveMp4(renditions);
  if (progressive) {
    return videoItem(id, index, progressive);
  }
  const master = hlsUrl(renditions);
  return master ? hlsVideoItem(input.net, id, index, master, input.preferredWidth) : null;
}

async function hlsVideoItem(net: Net, id: string, index: number | null, masterUrl: string, preferredWidth: number): Promise<MediaItem> {
  const headers = { "user-agent": browserUserAgent() };
  const suffix = index === null ? "" : `_${index}`;
  const base: MediaItem = {
    filename: filename(`pinterest_${id}${suffix}.mp4`),
    headers,
    hls: true,
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "pinterest",
    url: masterUrl,
  };
  const response = await net(masterUrl, { headers });
  if (!response.ok) {
    throw new Error(`Pinterest HLS failed: ${response.status}`);
  }
  const playlist = await response.text();
  if (!isMasterPlaylist(playlist)) {
    return base;
  }
  const master = parseMaster(playlist, masterUrl);
  const variant = pickVariant(master.variants, preferredWidth);
  if (!variant) {
    throw new Error("Pinterest HLS variant not found");
  }
  const audioUrl = variant.audioGroup ? master.audio[variant.audioGroup] : undefined;
  return { ...base, url: variant.url, ...(audioUrl ? { audio: { headers, url: audioUrl } } : {}) };
}

function pickVariant(variants: HlsVariant[], preferredWidth: number): HlsVariant | null {
  return variants.reduce<HlsVariant | null>((current, variant) => {
    if (!current) {
      return variant;
    }
    return Math.abs(variant.width - preferredWidth) < Math.abs(current.width - preferredWidth) ? variant : current;
  }, null);
}

function hlsUrl(renditions: Json[]): string | null {
  return renditions.map((rendition) => string(rendition.url)).find((url): url is string => url !== null && url.toLowerCase().includes(".m3u8")) ?? null;
}

function imageItems(pin: Json, id: string): MediaItem[] {
  const images = object(pin.images) ? pin.images : null;
  const orig = images && object(images.orig) ? images.orig : null;
  const url = orig ? string(orig.url) : null;
  if (!url) {
    return [];
  }
  return [
    {
      filename: filename(`pinterest_${id}.${imageExtension(url)}`),
      headers: { "user-agent": browserUserAgent() },
      id,
      kind: "image",
      mime: imageMime(url),
      platform: "pinterest",
      url,
    },
  ];
}

function videoList(videos: Json | null): Json[] {
  const list = videos && object(videos.video_list) ? videos.video_list : null;
  return list ? Object.values(list).filter(object) : [];
}

function progressiveMp4(renditions: Json[]): string | null {
  const mp4s = renditions.filter((rendition) => string(rendition.url)?.toLowerCase().endsWith(".mp4"));
  const best = mp4s.reduce<Json | null>((current, rendition) => {
    const width = number(rendition.width) ?? 0;
    const currentWidth = current ? number(current.width) ?? 0 : -1;
    return width > currentWidth ? rendition : current;
  }, null);
  return best ? string(best.url) : null;
}

function videoItem(id: string, index: number | null, url: string): MediaItem {
  const suffix = index === null ? "" : `_${index}`;
  return {
    filename: filename(`pinterest_${id}${suffix}.mp4`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "pinterest",
    url,
  };
}

function imageExtension(url: string): string {
  const extension = asUrl(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension === "png" || extension === "webp" || extension === "gif" ? extension : "jpg";
}

function imageMime(url: string): string {
  const extension = imageExtension(url);
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
