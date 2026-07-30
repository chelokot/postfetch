import {
  asUrl,
  bool,
  count,
  filename,
  isoFromEpochSeconds,
  object,
  string,
  type PostMetadata,
  type TiktokExtra,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import {
  browserUserAgent,
  firefoxNavigationHeaders,
  navigationHeaders,
} from "./fingerprint";

const marker = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
const pageAttemptCount = 12;

export async function resolveTiktok(input: ResolveContext): Promise<PostfetchResult> {
  const pageUrl = await followShortlink(input.net, browserUserAgent(), input.url);
  const id = videoId(pageUrl);
  if (!id) {
    throw new Error("TikTok video id not found");
  }
  const page = await videoPage(input.net, id, asUrl(pageUrl).pathname.includes("/photo/"));
  const user = author(page.item) ?? username(pageUrl) ?? "i";
  const headers: Record<string, string> = {
    referer: `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${encodeURIComponent(id)}`,
    "user-agent": page.userAgent,
  };
  if (page.cookie) {
    headers.cookie = page.cookie;
  }
  const items = mediaItems(page.item, user, id, headers);
  if (items.length === 0) {
    throw new Error("TikTok media not found");
  }
  return { archiveFilename: filename(`tiktok_${user}_${id}.zip`), id, items, metadata: tiktokMetadata(page.item), platform: "tiktok" };
}

async function videoPage(
  net: Net,
  id: string,
  photo: boolean,
): Promise<{ item: Json; cookie: string | null; userAgent: string }> {
  for (let attempt = 0; attempt < pageAttemptCount; attempt += 1) {
    const baseHeaders = attempt % 2 === 0 ? navigationHeaders() : firefoxNavigationHeaders();
    const userAgent = baseHeaders["user-agent"];
    const headers = {
      ...baseHeaders,
      referer: "https://www.tiktok.com/",
      "sec-fetch-site": "same-origin",
    };
    try {
      return { ...(await fetchVideoPage(net, id, headers)), userAgent };
    } catch (error) {
      if (!recoverablePageError(error)) {
        throw error;
      }
    }
  }

  if (!photo) {
    throw new Error("TikTok hydration not found");
  }
  const baseHeaders = navigationHeaders();
  const userAgent = baseHeaders["user-agent"];
  const headers = {
    ...baseHeaders,
    referer: "https://www.tiktok.com/",
    "sec-fetch-site": "same-origin",
  };
  return { ...(await fetchEmbedPage(net, id, headers)), userAgent };
}

export function tiktokMetadata(item: Json): PostMetadata & { extra?: TiktokExtra } {
  const user = object(item.author) ? item.author : null;
  const stats = object(item.stats) ? item.stats : null;
  const music = object(item.music) ? item.music : null;
  const video = object(item.video) ? item.video : null;
  return {
    text: string(item.desc) ?? undefined,
    author: user
      ? {
          handle: string(user.uniqueId) ?? undefined,
          name: string(user.nickname) ?? undefined,
          verified: bool(user.verified),
        }
      : undefined,
    createdAt: isoFromEpochSeconds(item.createTime),
    likeCount: stats ? count(stats.diggCount) : undefined,
    commentCount: stats ? count(stats.commentCount) : undefined,
    shareCount: stats ? count(stats.shareCount) : undefined,
    viewCount: stats ? count(stats.playCount) : undefined,
    extra: {
      saveCount: stats ? count(stats.collectCount) : undefined,
      musicTitle: music ? string(music.title) ?? undefined : undefined,
      musicAuthor: music ? string(music.authorName) ?? undefined : undefined,
      region: string(item.locationCreated) ?? undefined,
      durationSeconds: video ? count(video.duration) : undefined,
    },
  };
}

async function fetchVideoPage(
  net: Net,
  id: string,
  headers: Record<string, string>,
): Promise<{ item: Json; cookie: string | null }> {
  const page = await net(`https://www.tiktok.com/@i/video/${id}`, {
    headers,
  });
  return { cookie: cookieHeader(page.headers), item: itemStruct(await page.text()) };
}

async function fetchEmbedPage(
  net: Net,
  id: string,
  headers: Record<string, string>,
): Promise<{ item: Json; cookie: string | null }> {
  const page = await net(`https://www.tiktok.com/embed/v2/${id}`, {
    headers,
  });
  return { cookie: cookieHeader(page.headers), item: embedItemStruct(await page.text(), id) };
}

export function isShortlinkHost(hostname: string): boolean {
  return hostname === "vm.tiktok.com" || hostname === "vt.tiktok.com";
}

async function followShortlink(net: Net, userAgent: string, input: string): Promise<string> {
  const url = asUrl(input);
  if (!isShortlinkHost(url.hostname)) {
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
  // Photo (slideshow) posts share the video id namespace under /photo/<id>.
  return asUrl(input).pathname.match(/(?:video|photo)\/(\d+)/)?.[1] ?? null;
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

function embedItemStruct(html: string, id: string): Json {
  const raw = html.match(/<script\b[^>]*\bid=["']__FRONTITY_CONNECT_STATE__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) {
    throw new Error("TikTok embed state not found");
  }
  const parsed: unknown = JSON.parse(raw);
  const source = object(parsed) && object(parsed.source) ? parsed.source : null;
  const data = source && object(source.data) ? source.data : null;
  const rawRoute = data ? data[`/embed/v2/${id}`] : null;
  const route = object(rawRoute) ? rawRoute : null;
  const videoData = route && object(route.videoData) ? route.videoData : null;
  const item = videoData && object(videoData.itemInfos) ? videoData.itemInfos : null;
  if (!videoData || !item) {
    throw new Error("TikTok embed item not found");
  }

  const authorInfo = object(videoData.authorInfos) ? videoData.authorInfos : {};
  const musicInfo = object(videoData.musicInfos) ? videoData.musicInfos : {};
  const video = object(item.video) ? item.video : {};
  const videoMeta = object(video.videoMeta) ? video.videoMeta : {};
  const imagePost = object(videoData.imagePostInfo) ? videoData.imagePostInfo : null;
  const displayImages = imagePost && Array.isArray(imagePost.displayImages) ? imagePost.displayImages.filter(object) : [];
  if (displayImages.length === 0) {
    throw new Error("TikTok video hydration not found");
  }

  return {
    ...item,
    author: {
      nickname: string(authorInfo.nickName),
      uniqueId: string(authorInfo.uniqueId),
      verified: bool(authorInfo.verified),
    },
    desc: string(item.text),
    imagePost: {
      images: displayImages.map((image) => ({
        imageURL: {
          urlList: Array.isArray(image.urlList) ? image.urlList.map(string).filter((url): url is string => Boolean(url)) : [],
        },
      })),
    },
    music: {
      authorName: string(musicInfo.authorName),
      playUrl: firstString(musicInfo.playUrl),
      title: string(musicInfo.musicName),
    },
    stats: {
      commentCount: item.commentCount,
      diggCount: item.diggCount,
      playCount: item.playCount,
      shareCount: item.shareCount,
    },
    video: {
      duration: videoMeta.duration,
    },
  };
}

function recoverablePageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "TikTok WAF challenge" || message === "TikTok hydration not found";
}

function firstString(value: unknown): string | null {
  return Array.isArray(value)
    ? value.map(string).find((candidate): candidate is string => candidate !== null) ?? null
    : string(value);
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
