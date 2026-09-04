import { asUrl, createNet, PostfetchError, type MediaItem, type Platform, type PostfetchResult, type ResolveContext } from "./internal";
import { resolveFacebook } from "./facebook";
import { resolveInstagram } from "./instagram";
import { resolveLinkedin } from "./linkedin";
import { resolvePinterest } from "./pinterest";
import { resolveReddit } from "./reddit";
import { resolveSoundcloud } from "./soundcloud";
import { resolveTiktok } from "./tiktok";
import { resolveTwitter } from "./twitter";
import { resolveYoutube } from "./youtube";

/** Options for {@link postfetch}. */
export type PostfetchOptions = {
  /** Custom `fetch` implementation — inject one to unit-test resolvers offline. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Preferred media width in pixels; the closest available rendition is chosen. Defaults to `720`. */
  preferredWidth?: number;
  /**
   * Soft file-size cap in bytes. The normal rendition is resolved and probed
   * with HEAD; when it exceeds the cap, a smaller available rendition is
   * returned. X probes every available MP4 variant and picks the highest-quality
   * complete result under the cap, or its smallest variants when none fit. For
   * other platforms, if size discovery or a smaller rendition is unavailable,
   * the normal result is returned unchanged.
   */
  tryMaxBytes?: number;
};

/**
 * Resolve a public social post URL to its media.
 *
 * Detects the platform from the URL host, then returns the post's media as typed
 * {@link MediaItem}s — direct CDN URLs plus the headers needed to fetch them. It
 * performs no side effects beyond the lookup; use {@link download},
 * {@link downloadBlob}, {@link archive} or {@link toResponse} to turn the result
 * into bytes, a `Blob` or a `Response`.
 *
 * @param url A post URL from a supported platform.
 * @param options See {@link PostfetchOptions}.
 * @returns The resolved post and its media items.
 * @throws {PostfetchError} If the URL is empty or its host is unsupported.
 *
 * @example
 * ```ts
 * import { postfetch } from "@postfetch/core";
 *
 * const result = await postfetch("https://vt.tiktok.com/ZSxpHvCUM/");
 * for (const item of result.items) console.log(item.kind, item.url);
 * ```
 */
export async function postfetch(url: string, options: PostfetchOptions = {}): Promise<PostfetchResult> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new PostfetchError(400, "url is required");
  }
  if (options.tryMaxBytes !== undefined && (!Number.isSafeInteger(options.tryMaxBytes) || options.tryMaxBytes <= 0)) {
    throw new PostfetchError(400, "tryMaxBytes must be a positive integer");
  }
  const context: ResolveContext = {
    net: createNet(options.fetch ?? globalThis.fetch),
    preferredWidth: options.preferredWidth ?? 720,
    tryMaxBytes: options.tryMaxBytes,
    url: trimmed,
  };
  const result = await resolve(context);
  return options.tryMaxBytes === undefined || result.platform === "twitter"
    ? result
    : trySmaller(context, result, options.tryMaxBytes);
}

async function resolve(context: ResolveContext): Promise<PostfetchResult> {
  switch (detect(context.url)) {
    case "facebook":
      return resolveFacebook(context);
    case "instagram":
      return resolveInstagram(context);
    case "linkedin":
      return resolveLinkedin(context);
    case "pinterest":
      return resolvePinterest(context);
    case "reddit":
      return resolveReddit(context);
    case "soundcloud":
      return resolveSoundcloud(context);
    case "tiktok":
      return resolveTiktok(context);
    case "twitter":
      return resolveTwitter(context);
    case "youtube":
      return resolveYoutube(context);
  }
}

async function trySmaller(context: ResolveContext, result: PostfetchResult, maxBytes: number): Promise<PostfetchResult> {
  const originalBytes = await resultBytes(context, result);
  if (originalBytes === null || originalBytes <= maxBytes) {
    return result;
  }
  try {
    // Width-aware resolvers interpret 1px as "pick the smallest available".
    // Resolvers without a smaller rendition return the same media unchanged.
    const smaller = await resolve({ ...context, preferredWidth: 1 });
    if (sameMedia(result, smaller)) {
      return result;
    }
    const smallerBytes = await resultBytes(context, smaller);
    return smallerBytes !== null && smallerBytes < originalBytes ? smaller : result;
  } catch {
    return result;
  }
}

async function resultBytes(context: ResolveContext, result: PostfetchResult): Promise<number | null> {
  const sizes = await Promise.all(result.items.map((item) => itemBytes(context, item)));
  if (sizes.some((size) => size === null)) {
    return null;
  }
  return sizes.reduce<number>((total, size) => total + (size ?? 0), 0);
}

async function itemBytes(context: ResolveContext, item: MediaItem): Promise<number | null> {
  if (item.hls) {
    return null;
  }
  const [video, audio] = await Promise.all([
    contentLength(context, item.url, item.headers),
    item.audio ? contentLength(context, item.audio.url, item.audio.headers) : Promise.resolve(0),
  ]);
  return video === null || audio === null ? null : video + audio;
}

async function contentLength(context: ResolveContext, url: string, headers: HeadersInit): Promise<number | null> {
  try {
    const response = await context.net(url, { headers, method: "HEAD" }, 1);
    const raw = response.ok ? response.headers.get("content-length") : null;
    if (!raw || !/^\d+$/.test(raw)) {
      return null;
    }
    const bytes = Number(raw);
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function sameMedia(left: PostfetchResult, right: PostfetchResult): boolean {
  return left.items.length === right.items.length && left.items.every((item, index) => {
    const other = right.items[index];
    return item.url === other?.url && item.audio?.url === other.audio?.url;
  });
}

/**
 * Detect which platform a URL belongs to, from its host.
 *
 * @param url Any URL.
 * @returns The matched {@link Platform}.
 * @throws {PostfetchError} If the host is not a supported platform.
 */
export function detect(url: string): Platform {
  const host = asUrl(url).hostname;
  if (host.includes("tiktok.com")) {
    return "tiktok";
  }
  if (host.includes("instagram.com")) {
    return "instagram";
  }
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return "linkedin";
  }
  if (host.includes("pinterest.") || host === "pin.it") {
    return "pinterest";
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") {
    return "reddit";
  }
  if (host.includes("soundcloud.com") || host === "snd.sc") {
    return "soundcloud";
  }
  if (host.includes("youtube.com") || host === "youtu.be") {
    return "youtube";
  }
  if (host.includes("facebook.com") || host === "fb.watch") {
    return "facebook";
  }
  if (host === "x.com" || host.endsWith(".x.com") || host.includes("twitter.com")) {
    return "twitter";
  }
  throw new PostfetchError(400, "only Facebook, Instagram, LinkedIn, Pinterest, Reddit, SoundCloud, TikTok, X and YouTube URLs are supported");
}
