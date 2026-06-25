import { asUrl, createNet, PostfetchError, type Platform, type PostfetchResult } from "./internal";
import { resolveFacebook } from "./facebook";
import { resolveInstagram } from "./instagram";
import { resolveTiktok } from "./tiktok";
import { resolveTwitter } from "./twitter";
import { resolveYoutube } from "./youtube";

/** Options for {@link postfetch}. */
export type PostfetchOptions = {
  /** Custom `fetch` implementation — inject one to unit-test resolvers offline. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Preferred media width in pixels; the closest available rendition is chosen. Defaults to `720`. */
  preferredWidth?: number;
};

/**
 * Resolve a public social post URL to its media.
 *
 * Detects the platform from the URL host, then returns the post's media as typed
 * {@link MediaItem}s — direct CDN URLs plus the headers needed to fetch them. It
 * performs no side effects beyond the lookup; use {@link download}, {@link archive}
 * or {@link toResponse} to turn the result into bytes or a `Response`.
 *
 * @param url A post URL from Instagram, TikTok, YouTube, Facebook or X.
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
  const context = {
    net: createNet(options.fetch ?? globalThis.fetch),
    preferredWidth: options.preferredWidth ?? 720,
    url: trimmed,
  };
  switch (detect(trimmed)) {
    case "facebook":
      return resolveFacebook(context);
    case "instagram":
      return resolveInstagram(context);
    case "tiktok":
      return resolveTiktok(context);
    case "twitter":
      return resolveTwitter(context);
    case "youtube":
      return resolveYoutube(context);
  }
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
  if (host.includes("youtube.com") || host === "youtu.be") {
    return "youtube";
  }
  if (host.includes("facebook.com") || host === "fb.watch") {
    return "facebook";
  }
  if (host === "x.com" || host.endsWith(".x.com") || host.includes("twitter.com")) {
    return "twitter";
  }
  throw new PostfetchError(400, "only Facebook, Instagram, TikTok, X and YouTube URLs are supported");
}
