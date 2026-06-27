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

export async function resolvePinterest(input: ResolveContext): Promise<PostfetchResult> {
  const id = await pinId(input.net, input.url);
  const pin = await pinResource(input.net, id);
  const items = mediaItems(pin, id);
  if (items.length === 0) {
    throw new Error("Pinterest media not found");
  }
  return { archiveFilename: filename(`pinterest_${id}.zip`), id, items, platform: "pinterest" };
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

function mediaItems(pin: Json, id: string): MediaItem[] {
  const video = standardVideo(pin, id);
  if (video.length > 0) {
    return video;
  }
  const story = storyItems(pin, id);
  if (story.length > 0) {
    return story;
  }
  return imageItems(pin, id);
}

function standardVideo(pin: Json, id: string): MediaItem[] {
  const url = progressiveMp4(videoList(object(pin.videos) ? pin.videos : null));
  return url ? [videoItem(id, null, url)] : [];
}

// Idea pins carry their media as story blocks. Their videos are usually
// HLS-only; rather than silently fall back to the static cover image, a video
// block without a progressive rendition is reported as needing muxing.
function storyItems(pin: Json, id: string): MediaItem[] {
  const story = object(pin.story_pin_data) ? pin.story_pin_data : null;
  if (!story) {
    return [];
  }
  const pages = Array.isArray(story.pages) ? story.pages.filter(object) : [];
  const blocks = pages.flatMap((page) => (Array.isArray(page.blocks) ? page.blocks.filter(object) : []));
  const videoBlocks = blocks.filter((block) => object(block.video));
  const videos = videoBlocks.flatMap((block, index) => {
    const url = progressiveMp4(videoList(object(block.video) ? block.video : null));
    return url ? [videoItem(id, index + 1, url)] : [];
  });
  if (videos.length > 0) {
    return videos;
  }
  if (videoBlocks.length > 0) {
    throw new Error("Pinterest idea pin video is HLS-only (muxing required)");
  }
  return imageItems(pin, id);
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
