/**
 * Turn a public social post URL into its media.
 *
 * {@link postfetch} resolves Instagram, LinkedIn, TikTok, YouTube, Facebook and X (Twitter)
 * URLs to typed {@link MediaItem}s. Zero dependencies, only Web-standard APIs
 * (`fetch`, `Response`, `URL`, `crypto`) — so it runs on Deno, Node, Bun,
 * Cloudflare Workers and browsers alike. It only resolves the media; the
 * {@link download}, {@link downloadBlob}, {@link archive} and {@link toResponse}
 * helpers turn a result into bytes, a `Blob`, or a `Response`.
 *
 * @example Resolve a reel and save the video
 * ```ts
 * import { postfetch, download } from "@postfetch/core";
 *
 * const result = await postfetch("https://www.instagram.com/reel/DZ0ixNxtvYq/");
 * const [item] = result.items; // { kind: "video", url, headers, filename, ... }
 * const response = await download(item);
 * ```
 *
 * @module
 */
export { postfetch, detect, type PostfetchOptions } from "./postfetch";
export {
  download,
  downloadBlob,
  archive,
  toResponse,
  type Archive,
  type DownloadOptions,
} from "./download";
export { PostfetchError } from "./internal";
export type {
  InstagramExtra,
  MediaItem,
  MediaKind,
  PinterestExtra,
  Platform,
  PlatformResult,
  PostAuthor,
  PostfetchReason,
  PostfetchResult,
  PostMetadata,
  RedditExtra,
  SoundcloudExtra,
  TiktokExtra,
  TwitterExtra,
  TwitterQuotedTweet,
  YoutubeExtra,
} from "./internal";
