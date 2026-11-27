import {
  asUrl,
  bool,
  count,
  filename,
  isoFromEpochSeconds,
  number,
  object,
  PostfetchError,
  string,
  type Json,
  type MediaItem,
  type Net,
  type PostComment,
  type PostfetchReason,
  type PostfetchResult,
  type PostMetadata,
  type ResolveContext,
  type ThreadsExtra,
} from "./internal";
import { browserUserAgent, navigationHeaders } from "./fingerprint";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;

export async function resolveThreads(input: ResolveContext): Promise<PostfetchResult> {
  const canonical = await resolveCanonicalUrl(input.net, input.url);
  const code = postShortcode(canonical);
  if (!code) {
    throw new PostfetchError(400, "Threads post id not found");
  }

  const response = await input.net(canonical, { headers: navigationHeaders() });
  checkResponse(response);
  const html = await response.text();
  const payload = parsePagePayload(html, code);
  if (!payload.media) {
    throw new PostfetchError(404, "Threads post unavailable: notFound", "notFound");
  }

  const media = payload.media;
  const gatingReason = gatingFailure(media);
  const items = threadsPostItems(media, code, input.preferredWidth, new Set([code]));
  const metadata = threadsMetadata(media, new Set([code]));

  if (items.length === 0 && !metadata.text && !metadata.extra?.quotedPost) {
    const reason = gatingReason ?? (privateUser(media) ? "private" : "notFound");
    throw new PostfetchError(reasonStatus(reason), `Threads post unavailable: ${reason}`, reason);
  }

  const comments = threadsComments(payload.replies, media, input.comments, input.preferredWidth);
  return {
    archiveFilename: filename(`threads_${code}.zip`),
    comments,
    id: code,
    items,
    metadata,
    platform: "threads",
  };
}

export function threadsMetadata(media: Json, seen = new Set<string>()): PostMetadata & { extra?: ThreadsExtra } {
  const user = object(media.user) ? media.user : null;
  const info = object(media.text_post_app_info) ? media.text_post_app_info : null;
  const countsHidden = bool(media.like_and_view_counts_disabled);
  const extra: ThreadsExtra = {};
  const replyToId = info ? string(info.reply_to_post_id) : null;
  const isReply = info ? bool(info.is_reply) : undefined;
  const quoteCount = info ? count(info.quote_count) : undefined;

  if (replyToId) {
    extra.replyToId = replyToId;
  }
  if (isReply !== undefined) {
    extra.isReply = isReply;
  }
  if (quoteCount !== undefined) {
    extra.quoteCount = quoteCount;
  }

  const quoted = quotedPostObject(media);
  const quotedCode = quoted ? string(quoted.code) : null;
  if (quoted && quotedCode && !seen.has(quotedCode)) {
    const nextSeen = new Set(seen);
    nextSeen.add(quotedCode);
    extra.quotedPost = {
      id: quotedCode,
      metadata: threadsMetadata(quoted, nextSeen),
    };
  }

  return {
    text: threadsCaption(media),
    author: user
      ? {
          handle: string(user.username) ?? undefined,
          name: string(user.full_name) ?? undefined,
          verified: bool(user.is_verified),
        }
      : undefined,
    createdAt: isoFromEpochSeconds(media.taken_at),
    likeCount: countsHidden ? undefined : count(media.like_count),
    commentCount: info ? count(info.direct_reply_count) : undefined,
    shareCount: info ? count(info.repost_count) : undefined,
    ...(Object.keys(extra).length > 0 && { extra }),
  };
}

function isThreadsHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "threads.com" ||
    normalized.endsWith(".threads.com") ||
    normalized === "threads.net" ||
    normalized.endsWith(".threads.net")
  );
}

function isSharePath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0]?.toLowerCase() === "share";
}

function hasValidShareToken(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "share") {
    return false;
  }
  if (parts.length === 2) {
    return parts[1].toLowerCase() !== "p";
  }
  return parts.length >= 3 && parts[1].toLowerCase() === "p" && parts[2].length > 0;
}

function isShortPostPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0]?.toLowerCase() === "t" && Boolean(parts[1]);
}

function postShortcode(input: string): string | null {
  let pathname: string;
  try {
    const url = new URL(input);
    if (!isThreadsHost(url.hostname)) {
      return null;
    }
    pathname = url.pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "share") {
    return null;
  }
  if ((parts[0] === "t" || parts[0] === "post") && parts[1]) {
    return parts[1];
  }
  if (parts[1] === "post" && parts[2]) {
    return parts[2];
  }
  return null;
}

function unwrapLoginNext(url: URL): string | null {
  if (!url.pathname.startsWith("/login") && !url.pathname.startsWith("/accounts/login")) {
    return null;
  }
  const next = url.searchParams.get("next");
  if (!next) {
    return null;
  }
  try {
    const resolved = new URL(next, url);
    return isThreadsHost(resolved.hostname) ? resolved.href : null;
  } catch {
    return null;
  }
}

async function resolveCanonicalUrl(net: Net, input: string): Promise<string> {
  const parsed = asUrl(input);
  if (!isThreadsHost(parsed.hostname)) {
    throw new PostfetchError(400, "Threads post id not found");
  }
  if (isSharePath(parsed.pathname)) {
    if (!hasValidShareToken(parsed.pathname)) {
      throw new PostfetchError(400, "Threads post id not found");
    }
    return resolveRedirectUrl(net, input, "share");
  }
  if (isShortPostPath(parsed.pathname)) {
    return resolveRedirectUrl(net, input, "short");
  }
  if (!postShortcode(input)) {
    throw new PostfetchError(400, "Threads post id not found");
  }
  return `${parsed.origin}${parsed.pathname}`;
}

async function resolveRedirectUrl(net: Net, input: string, kind: "share" | "short"): Promise<string> {
  let current = input;
  for (let hop = 0; hop < maxRedirects; hop += 1) {
    const response = await net(current, { headers: navigationHeaders(), redirect: "manual" });
    if (response.status === 429) {
      await response.body?.cancel();
      throw new PostfetchError(429, "Threads rate limit reached", "rateLimited");
    }
    const location = redirectStatuses.has(response.status) ? response.headers.get("location") : null;
    if (location) {
      await response.body?.cancel();
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, current);
      } catch {
        break;
      }
      if (!isThreadsHost(nextUrl.hostname)) {
        break;
      }
      const unwrapped = unwrapLoginNext(nextUrl);
      if ((nextUrl.pathname.startsWith("/login") || nextUrl.pathname.startsWith("/accounts/login")) && !unwrapped) {
        throw new PostfetchError(401, "Threads login required", "loginRequired");
      }
      const target = new URL(unwrapped ?? nextUrl.href);
      current = `${target.origin}${target.pathname}`;
      if (postShortcode(current) && !isShortPostPath(target.pathname)) {
        return current;
      }
      if (!isSharePath(target.pathname) && !isShortPostPath(target.pathname)) {
        break;
      }
      continue;
    }
    if (response.url) {
      try {
        const finalUrl = new URL(response.url);
        if (isThreadsHost(finalUrl.hostname)) {
          const unwrapped = unwrapLoginNext(finalUrl);
          const candidate = new URL(unwrapped ?? finalUrl.href);
          if (postShortcode(candidate.href) && (kind === "short" || !isSharePath(candidate.pathname))) {
            await response.body?.cancel();
            return `${candidate.origin}${candidate.pathname}`;
          }
        }
      } catch {
        // Ignore malformed response.url from test stubs.
      }
    }
    await response.body?.cancel();
    if (kind === "short" && response.ok) {
      return current;
    }
    break;
  }
  throw new PostfetchError(404, "Threads post unavailable: notFound", "notFound");
}

function checkResponse(response: Response): void {
  if (response.status === 404) {
    throw new PostfetchError(404, "Threads post unavailable: notFound", "notFound");
  }
  if (response.status === 429) {
    throw new PostfetchError(429, "Threads rate limit reached", "rateLimited");
  }
  if (!response.ok) {
    throw new PostfetchError(response.status, "Threads post unavailable", "unavailable");
  }
  if (response.url) {
    try {
      const finalUrl = new URL(response.url);
      if (finalUrl.pathname.startsWith("/login") || finalUrl.pathname.startsWith("/accounts/login")) {
        throw new PostfetchError(401, "Threads login required", "loginRequired");
      }
    } catch (error) {
      if (error instanceof PostfetchError) {
        throw error;
      }
    }
  }
}

type PagePayload = {
  media: Json | null;
  replies: Json | null;
};

function parsePagePayload(html: string, code: string): PagePayload {
  const candidates: Json[] = [];
  const replyContainers: Json[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype=["']application\/json["']/i.test(match[1])) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[2]);
    } catch {
      continue;
    }
    collectPageNodes(parsed, code, candidates, replyContainers);
  }

  let media: Json | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = mediaScore(candidate);
    if (score > bestScore) {
      bestScore = score;
      media = candidate;
    }
  }

  const mediaId = media ? string(media.id) : null;
  const mediaPk = media ? string(media.pk) : null;
  const replies = replyContainers.find((entry) => {
    const id = string(entry.id);
    const pk = string(entry.pk);
    if (mediaId && id === mediaId) return true;
    if (mediaPk && (pk === mediaPk || id?.startsWith(`${mediaPk}_`))) return true;
    return string(entry.code) === code;
  }) ?? (replyContainers.length === 1 ? replyContainers[0] : null);

  return { media, replies };
}

function collectPageNodes(node: unknown, code: string, candidates: Json[], replyContainers: Json[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectPageNodes(child, code, candidates, replyContainers);
    }
    return;
  }
  if (!object(node)) {
    return;
  }

  if (string(node.code) === code && looksLikeThreadsPost(node)) {
    candidates.push(node);
  }
  if (object(node.text_post_app_info) && (object(node.text_post_app_info.direct_replies) || object(node.text_post_app_info.self_thread))) {
    replyContainers.push(node);
  }

  for (const key in node) {
    collectPageNodes(node[key], code, candidates, replyContainers);
  }
}

function looksLikeThreadsPost(node: Json): boolean {
  return (
    object(node.text_post_app_info) ||
    object(node.caption) ||
    Array.isArray(node.video_versions) ||
    Array.isArray(node.carousel_media) ||
    (object(node.image_versions2) && Array.isArray(node.image_versions2.candidates)) ||
    object(node.audio) ||
    object(node.gating_ruling)
  );
}

function mediaScore(node: Json): number {
  let score = 0;
  if (object(node.text_post_app_info)) score += 4;
  if (object(node.caption)) score += 3;
  if (object(node.user)) score += 2;
  if (Array.isArray(node.video_versions) && node.video_versions.length > 0) score += 2;
  if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) score += 2;
  if (object(node.image_versions2) && Array.isArray(node.image_versions2.candidates) && node.image_versions2.candidates.length > 0) score += 1;
  if (count(node.like_count) !== undefined) score += 1;
  if (count(node.taken_at) !== undefined) score += 1;
  return score;
}

function threadsCaption(media: Json): string | undefined {
  if (object(media.caption)) {
    const text = string(media.caption.text);
    if (text) return text;
  }
  const direct = string(media.caption);
  if (direct) return direct;

  const info = object(media.text_post_app_info) ? media.text_post_app_info : null;
  const textFragments = info && object(info.text_fragments) && Array.isArray(info.text_fragments.fragments)
    ? info.text_fragments.fragments.filter(object)
    : [];
  const joined = textFragments
    .map((fragment) => (typeof fragment.plaintext === "string" ? fragment.plaintext : ""))
    .join("")
    .trim();
  return joined.length > 0 ? joined : undefined;
}

function quotedPostObject(media: Json): Json | null {
  const info = object(media.text_post_app_info) ? media.text_post_app_info : null;
  const shareInfo = info && object(info.share_info) ? info.share_info : null;
  if (!shareInfo) {
    return null;
  }
  if (object(shareInfo.quoted_post)) {
    return shareInfo.quoted_post;
  }
  if (object(shareInfo.quoted_attachment_post)) {
    return shareInfo.quoted_attachment_post;
  }
  return null;
}

function threadsPostItems(media: Json, code: string, preferredWidth: number, seen: Set<string>): MediaItem[] {
  const items = threadsOwnItems(media, code, preferredWidth);

  const quoted = quotedPostObject(media);
  const quotedCode = quoted ? string(quoted.code) : null;
  if (quoted && quotedCode && !seen.has(quotedCode)) {
    const nextSeen = new Set(seen);
    nextSeen.add(quotedCode);
    items.push(...threadsPostItems(quoted, quotedCode, preferredWidth, nextSeen));
  }

  const preview = threadsLinkPreview(media, code);
  if (preview) {
    items.push(preview);
  }

  return items;
}

function threadsOwnItems(media: Json, code: string, preferredWidth: number): MediaItem[] {
  const carousel = Array.isArray(media.carousel_media) ? media.carousel_media.filter(object) : [];
  if (carousel.length > 0) {
    return carousel.flatMap((entry, index) => threadsMediaItem(entry, code, index + 1, preferredWidth));
  }
  return threadsMediaItem(media, code, null, preferredWidth);
}

function threadsMediaItem(media: Json, code: string, index: number | null, preferredWidth: number): MediaItem[] {
  const headers = { "user-agent": browserUserAgent() };
  const suffix = index === null ? "" : `_${index}`;

  const video = selectVersion(media.video_versions, preferredWidth);
  if (video) {
    return [{
      filename: filename(`threads_${code}${suffix}.mp4`),
      headers,
      id: code,
      kind: "video",
      mime: "video/mp4",
      platform: "threads",
      url: video,
    }];
  }

  const image = selectImage(media);
  if (image) {
    const { extension, mime } = imageFormat(image);
    return [{
      filename: filename(`threads_${code}${suffix}.${extension}`),
      headers,
      id: code,
      kind: "image",
      mime,
      platform: "threads",
      url: image,
    }];
  }

  const audio = selectAudio(media);
  if (audio) {
    return [{
      filename: filename(`threads_${code}${suffix}.m4a`),
      headers,
      id: code,
      kind: "audio",
      mime: "audio/mp4",
      platform: "threads",
      url: audio,
    }];
  }

  const giphy = selectGiphy(media);
  if (giphy) {
    return [{
      filename: filename(`threads_${code}${suffix}.${giphy.extension}`),
      headers,
      id: code,
      kind: giphy.kind,
      mime: giphy.mime,
      platform: "threads",
      url: giphy.url,
    }];
  }

  return [];
}

function threadsLinkPreview(media: Json, code: string): MediaItem | null {
  const info = object(media.text_post_app_info) ? media.text_post_app_info : null;
  const attachment = info && object(info.link_preview_attachment) ? info.link_preview_attachment : null;
  const rawUrl = attachment ? string(attachment.image_url) : null;
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const { extension, mime } = imageFormat(parsed.href);
    return {
      filename: filename(`threads_${code}_preview.${extension}`),
      headers: { "user-agent": browserUserAgent() },
      id: code,
      kind: "image",
      mime,
      platform: "threads",
      role: "linkPreview",
      url: parsed.href,
    };
  } catch {
    return null;
  }
}

function selectVersion(value: unknown, preferredWidth: number): string | null {
  const versions = Array.isArray(value) ? value.filter(object) : [];
  const best = versions.reduce<Json | null>((current, candidate) => {
    const url = string(candidate.url);
    if (!url) return current;
    const width = number(candidate.width);
    const currentWidth = current ? number(current.width) : null;
    if (width === null) {
      return current ?? candidate;
    }
    if (currentWidth === null) {
      return candidate;
    }
    return Math.abs(width - preferredWidth) < Math.abs(currentWidth - preferredWidth) ? candidate : current;
  }, null);
  return best ? string(best.url) : null;
}

function selectImage(media: Json): string | null {
  const candidates = object(media.image_versions2) && Array.isArray(media.image_versions2.candidates)
    ? media.image_versions2.candidates.filter(object)
    : [];
  const best = candidates.reduce<Json | null>((current, candidate) => {
    const url = string(candidate.url);
    if (!url) return current;
    if (!current) return candidate;
    const area = (number(candidate.width) ?? 0) * (number(candidate.height) ?? 0);
    const currentArea = (number(current.width) ?? 0) * (number(current.height) ?? 0);
    return area > currentArea ? candidate : current;
  }, null);
  return best ? string(best.url) : null;
}

function selectAudio(media: Json): string | null {
  const audio = object(media.audio) ? media.audio : null;
  const url = audio ? string(audio.audio_src) : null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function selectGiphy(media: Json): { extension: string; kind: "image" | "video"; mime: string; url: string } | null {
  const giphy = object(media.giphy_media_info) ? media.giphy_media_info : null;
  if (!giphy) return null;
  const images = object(giphy.first_party_cdn_proxied_images)
    ? giphy.first_party_cdn_proxied_images
    : object(giphy.images)
      ? giphy.images
      : null;
  if (!images) return null;
  const variant = object(images.fixed_height) ? images.fixed_height : object(images.original) ? images.original : null;
  if (!variant) return null;
  const mp4 = string(variant.mp4);
  if (mp4 && /^https?:\/\//i.test(mp4)) {
    return { extension: "mp4", kind: "video", mime: "video/mp4", url: mp4 };
  }
  const webp = string(variant.webp) ?? string(variant.url);
  if (webp && /^https?:\/\//i.test(webp)) {
    const { extension, mime } = imageFormat(webp);
    return { extension, kind: "image", mime, url: webp };
  }
  return null;
}

function imageFormat(rawUrl: string): { extension: string; mime: string } {
  try {
    const pathname = new URL(rawUrl).pathname;
    const matched = pathname.match(/\.(jpe?g|png|webp|gif)$/i)?.[1]?.toLowerCase();
    if (matched === "png") return { extension: "png", mime: "image/png" };
    if (matched === "webp") return { extension: "webp", mime: "image/webp" };
    if (matched === "gif") return { extension: "gif", mime: "image/gif" };
  } catch {
    // Fall back to JPEG when URL cannot be parsed.
  }
  return { extension: "jpg", mime: "image/jpeg" };
}

function threadsComments(
  container: Json | null,
  rootMedia: Json,
  limit: number | undefined,
  preferredWidth: number,
): PostComment[] {
  if (!limit || !Number.isSafeInteger(limit) || limit <= 0) {
    return [];
  }
  const rootCode = string(rootMedia.code);
  const info = container && object(container.text_post_app_info)
    ? container.text_post_app_info
    : object(rootMedia.text_post_app_info)
      ? rootMedia.text_post_app_info
      : null;
  if (!info) {
    return [];
  }

  const selfThread = extractEdgePosts(object(info.self_thread) ? info.self_thread.posts : null)
    .filter((post) => string(post.code) !== rootCode);

  const selectedPosts = selfThread.length > 0
    ? selfThread
    : extractDirectReplyPosts(info.direct_replies).filter((post) => string(post.code) !== rootCode);

  const seen = new Set<string>();
  const comments: PostComment[] = [];
  for (const post of selectedPosts) {
    if (comments.length >= limit) break;
    const code = string(post.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const user = object(post.user) ? post.user : null;
    const handle = user ? string(user.username) : null;
    comments.push({
      id: code,
      url: handle ? `https://www.threads.com/@${encodeURIComponent(handle)}/post/${code}` : `https://www.threads.com/t/${code}`,
      metadata: threadsMetadata(post, new Set([code])),
      items: threadsOwnItems(post, code, preferredWidth),
    });
  }
  return comments;
}

function extractEdgePosts(connection: unknown): Json[] {
  if (!object(connection) || !Array.isArray(connection.edges)) {
    return [];
  }
  return connection.edges.flatMap((edge) => {
    const node = object(edge) && object(edge.node) ? edge.node : null;
    return node ? [node] : [];
  });
}

function extractDirectReplyPosts(connection: unknown): Json[] {
  if (!object(connection) || !Array.isArray(connection.edges)) {
    return [];
  }
  const posts: Json[] = [];
  for (const edge of connection.edges) {
    const node = object(edge) && object(edge.node) ? edge.node : null;
    if (!node) continue;
    const threadPosts = extractEdgePosts(node.posts);
    if (threadPosts[0]) {
      posts.push(threadPosts[0]);
      continue;
    }
    if (string(node.code)) {
      posts.push(node);
    }
  }
  return posts;
}

function gatingFailure(media: Json): PostfetchReason | undefined {
  if (!object(media.gating_ruling)) {
    return undefined;
  }
  const raw = JSON.stringify(media.gating_ruling);
  if (/MIN_AGE_ACCOUNT|under 18|age[- ]restricted/i.test(raw)) {
    return "ageRestricted";
  }
  if (/private account|"is_private":\s*true|account is private/i.test(raw)) {
    return "private";
  }
  if (/log in|login_required|not logged/i.test(raw)) {
    return "loginRequired";
  }
  return "unavailable";
}

function privateUser(media: Json): boolean {
  const user = object(media.user) ? media.user : null;
  return Boolean(user && (user.text_post_app_is_private === true || user.is_private === true));
}

function reasonStatus(reason: PostfetchReason): number {
  switch (reason) {
    case "ageRestricted":
      return 451;
    case "private":
      return 403;
    case "loginRequired":
      return 401;
    case "rateLimited":
      return 429;
    default:
      return 404;
  }
}
