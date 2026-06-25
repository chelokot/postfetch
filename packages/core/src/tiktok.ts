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
import { browserUserAgent, firefoxUserAgent } from "./fingerprint";

const marker = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';

export async function resolveTiktok(input: ResolveContext): Promise<PostfetchResult> {
  const userAgent = browserUserAgent();
  const pageUrl = await followShortlink(input.net, userAgent, input.url);
  const id = videoId(pageUrl);
  if (!id) {
    throw new Error("TikTok video id not found");
  }
  const page = await fetchVideoPage(input.net, id, userAgent).catch((error: unknown) => {
    if (!recoverablePageError(error)) {
      throw error;
    }
    return fetchVideoPage(input.net, id, firefoxUserAgent());
  });
  const user = author(page.item) ?? username(pageUrl) ?? "i";
  const headers: Record<string, string> = {
    referer: `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${encodeURIComponent(id)}`,
    "user-agent": userAgent,
  };
  if (page.cookie) {
    headers.cookie = page.cookie;
  }
  const items = mediaItems(page.item, user, id, headers);
  if (items.length === 0) {
    throw new Error("TikTok media not found");
  }
  return { archiveFilename: filename(`tiktok_${user}_${id}.zip`), id, items, platform: "tiktok" };
}

async function fetchVideoPage(
  net: Net,
  id: string,
  userAgent: string,
): Promise<{ item: Json; cookie: string | null }> {
  const page = await net(`https://www.tiktok.com/@i/video/${id}`, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      referer: "https://www.tiktok.com/",
      "user-agent": userAgent,
    },
  });
  return { cookie: cookieHeader(page.headers), item: itemStruct(await page.text()) };
}

async function followShortlink(net: Net, userAgent: string, input: string): Promise<string> {
  const url = asUrl(input);
  if (!url.hostname.includes("vt.tiktok.com")) {
    return input;
  }
  const response = await net(input, { headers: { "user-agent": userAgent }, redirect: "manual" }, 1);
  const location = response.headers.get("location");
  if (location) {
    return new URL(location, input).href;
  }
  const html = await response.text();
  const href = html.match(/<a href="(https:\/\/[^"]+)"/)?.[1];
  return href ? new URL(href.split("?")[0]).href : input;
}

function videoId(input: string): string | null {
  return asUrl(input).pathname.match(/video\/(\d+)/)?.[1] ?? null;
}

function itemStruct(html: string): Json {
  if (html.includes("SlardarWAF") || html.includes("_wafchallengeid")) {
    throw new Error("TikTok WAF challenge");
  }
  const start = html.indexOf(marker);
  const end = start === -1 ? -1 : html.indexOf("</script>", start + marker.length);
  if (start === -1 || end === -1) {
    throw new Error("TikTok hydration not found");
  }
  const parsed: unknown = JSON.parse(html.slice(start + marker.length, end));
  const scope = object(parsed) && object(parsed.__DEFAULT_SCOPE__) ? parsed.__DEFAULT_SCOPE__ : null;
  const detail = scope && object(scope["webapp.video-detail"]) ? scope["webapp.video-detail"] : null;
  const info = detail && object(detail.itemInfo) ? detail.itemInfo : null;
  const item = info && object(info.itemStruct) ? info.itemStruct : null;
  if (!item) {
    throw new Error("TikTok itemStruct not found");
  }
  return item;
}

function recoverablePageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "TikTok WAF challenge" || message === "TikTok hydration not found";
}

function downloadUrl(item: Json): string | null {
  const video = object(item.video) ? item.video : null;
  return video ? string(video.playAddr) ?? string(video.downloadAddr) : null;
}

function mediaItems(item: Json, user: string, id: string, headers: HeadersInit): MediaItem[] {
  const images = imageItems(item, user, id, headers);
  if (images.length > 0) {
    const audio = audioItem(item, user, id, headers);
    return audio ? [...images, audio] : images;
  }
  const url = downloadUrl(item);
  return url
    ? [{
      filename: filename(`tiktok_${user}_${id}.mp4`),
      headers,
      id,
      kind: "video",
      mime: "video/mp4",
      platform: "tiktok",
      url,
    }]
    : [];
}

function imageItems(item: Json, user: string, id: string, headers: HeadersInit): MediaItem[] {
  const imagePost = object(item.imagePost) ? item.imagePost : null;
  const images = imagePost && Array.isArray(imagePost.images) ? imagePost.images.filter(object) : [];
  return images.flatMap((image, index) => {
    const imageUrl = object(image.imageURL) ? image.imageURL : null;
    const list = imageUrl && Array.isArray(imageUrl.urlList) ? imageUrl.urlList : [];
    const url = list.map(string).find((candidate): candidate is string => Boolean(candidate)) ?? null;
    return url
      ? [{
        filename: filename(`tiktok_${user}_${id}_${index + 1}.jpg`),
        headers,
        id,
        kind: "image" as const,
        mime: "image/jpeg",
        platform: "tiktok" as const,
        url,
      }]
      : [];
  });
}

function audioItem(item: Json, user: string, id: string, headers: HeadersInit): MediaItem | null {
  const video = object(item.video) ? item.video : null;
  const music = object(item.music) ? item.music : null;
  const url = video ? string(video.playAddr) : null;
  const fallback = music ? string(music.playUrl) : null;
  const selected = url ?? fallback;
  if (!selected) {
    return null;
  }
  const extension = selected.includes("mime_type=audio_mpeg") ? "mp3" : "m4a";
  return {
    filename: filename(`tiktok_${user}_${id}_audio.${extension}`),
    headers,
    id,
    kind: "audio",
    mime: extension === "mp3" ? "audio/mpeg" : "audio/mp4",
    platform: "tiktok",
    url: selected,
  };
}

function author(item: Json): string | null {
  const user = object(item.author) ? item.author : null;
  return user ? string(user.uniqueId) : null;
}

function username(input: string): string | null {
  return asUrl(input).pathname.match(/@([^/]+)/)?.[1] ?? null;
}

function cookieHeader(headers: Headers): string | null {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookie = typeof getter === "function" ? getter.call(headers).join(",") : headers.get("set-cookie");
  const cookies = setCookie
    ?.split(/,(?=[^;]+?=)/)
    .map((part) => part.split(";")[0]?.trim())
    .filter((part): part is string => Boolean(part));
  return cookies && cookies.length > 0 ? cookies.join("; ") : null;
}
