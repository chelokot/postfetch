import { asUrl, createNet, PostfetchError, type Platform, type PostfetchResult } from "./internal";
import { resolveFacebook } from "./facebook";
import { resolveInstagram } from "./instagram";
import { resolveTiktok } from "./tiktok";
import { resolveYoutube } from "./youtube";

export type PostfetchOptions = {
  fetch?: typeof fetch;
  preferredWidth?: number;
};

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
    case "youtube":
      return resolveYoutube(context);
  }
}

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
  throw new PostfetchError(400, "only Facebook, Instagram, TikTok and YouTube URLs are supported");
}
