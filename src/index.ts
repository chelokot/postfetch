import { HttpError, asUrl, type Input, type MediaResult, type Platform } from "./core";
import { resolveInstagram } from "./instagram";
import { resolveTiktok } from "./tiktok";
import { resolveYoutube } from "./youtube";

export { HttpError };
export type { Input, MediaKind, MediaResult, MediaSource, Platform } from "./core";

export type PostfetchOptions = {
  platform?: Platform | "auto";
  preferredWidth?: number;
};

export async function postfetch(url: string, options: PostfetchOptions = {}): Promise<MediaResult> {
  return resolve({
    platform: options.platform ?? "auto",
    preferredWidth: options.preferredWidth ?? 720,
    url,
  });
}

export async function resolve(input: Input): Promise<MediaResult> {
  const selected = input.platform === "auto" ? detect(input.url) : input.platform;
  if (selected === "tiktok") {
    return resolveTiktok(input);
  }
  if (selected === "instagram") {
    return resolveInstagram(input);
  }
  if (selected === "youtube") {
    return resolveYoutube(input);
  }
  throw new HttpError(400, "only Instagram, TikTok and YouTube URLs are supported");
}

export function detect(input: string): Platform {
  const host = asUrl(input).hostname;
  if (host.includes("tiktok.com")) {
    return "tiktok";
  }
  if (host.includes("instagram.com")) {
    return "instagram";
  }
  if (host.includes("youtube.com") || host === "youtu.be") {
    return "youtube";
  }
  throw new HttpError(400, "only Instagram, TikTok and YouTube URLs are supported");
}
