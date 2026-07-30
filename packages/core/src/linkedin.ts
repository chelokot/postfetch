import {
  count,
  filename,
  isoFromDateString,
  object,
  PostfetchError,
  string,
  type Json,
  type MediaItem,
  type PostMetadata,
  type PostfetchResult,
  type ResolveContext,
} from "./internal";
import { browserUserAgent, navigationHeaders } from "./fingerprint";

type LinkedinPostKind = "activity" | "share" | "ugcPost";

type LinkedinPostReference = {
  id: string;
  kind: LinkedinPostKind;
};

export async function resolveLinkedin(input: ResolveContext): Promise<PostfetchResult> {
  const reference = postReference(input.url);
  const pageUrl = `https://www.linkedin.com/feed/update/urn:li:${reference.kind}:${reference.id}`;
  const response = await input.net(pageUrl, { headers: navigationHeaders() });
  if (response.status === 404) {
    throw new PostfetchError(404, "LinkedIn post not found", "notFound");
  }
  if (response.status === 429 || response.status === 999) {
    throw new PostfetchError(429, "LinkedIn rate limit reached", "rateLimited");
  }
  if (!response.ok) {
    throw new PostfetchError(response.status, "LinkedIn post unavailable", "unavailable");
  }
  if (response.url.includes("/signup/") || response.url.includes("/login")) {
    throw new PostfetchError(401, "LinkedIn login required", "loginRequired");
  }

  const html = await response.text();
  const post = linkedinPost(html);
  if (!post) {
    throw new PostfetchError(404, "LinkedIn post unavailable", "unavailable");
  }
  const canonical = string(post["@id"]);
  const canonicalReference = canonical ? postReferenceOrNull(canonical) : null;
  const id = canonicalReference?.id ?? reference.id;
  const items = linkedinItems(post, html, id, pageUrl);
  if (items.length === 0) {
    throw new Error("LinkedIn media url not found");
  }
  return {
    archiveFilename: filename(`linkedin_${id}.zip`),
    id,
    items,
    metadata: linkedinMetadata(post),
    platform: "linkedin",
  };
}

export function linkedinMetadata(post: Json): PostMetadata {
  const author = linkedinAuthor(post);
  return {
    title: string(post.text) ?? string(post.name) ?? string(post.headline) ?? undefined,
    text: string(post.description) ?? string(post.articleBody) ?? string(post.text) ?? undefined,
    author: author
      ? {
          handle: linkedinHandle(string(author.url)) ?? undefined,
          name: string(author.name) ?? undefined,
        }
      : undefined,
    createdAt: isoFromDateString(post.datePublished ?? post.uploadDate),
    likeCount: interactionCount(post.interactionStatistic, "LikeAction"),
    commentCount: count(post.commentCount) ?? interactionCount(post.interactionStatistic, "CommentAction"),
  };
}

function postReference(input: string): LinkedinPostReference {
  const reference = postReferenceOrNull(input);
  if (!reference) {
    throw new PostfetchError(400, "LinkedIn post id not found");
  }
  return reference;
}

function postReferenceOrNull(input: string): LinkedinPostReference | null {
  let pathname: string;
  try {
    pathname = new URL(input).pathname.replace(/%3A/gi, ":");
  } catch {
    return null;
  }
  const urn = pathname.match(/\/(?:embed\/)?feed\/update\/urn:li:(activity|share|ugcpost):(\d+)\/?$/i);
  const post = pathname.match(/\/posts\/[^/]*-(activity|share|ugcpost)-(\d+)(?:-[^/]*)?\/?$/i);
  const match = urn ?? post;
  if (!match) {
    return null;
  }
  switch (match[1].toLowerCase()) {
    case "activity":
      return { id: match[2], kind: "activity" };
    case "share":
      return { id: match[2], kind: "share" };
    case "ugcpost":
      return { id: match[2], kind: "ugcPost" };
    default:
      return null;
  }
}

function linkedinAuthor(post: Json): Json | null {
  if (object(post.creator)) {
    return post.creator;
  }
  if (object(post.author)) {
    return post.author;
  }
  return null;
}

function linkedinPost(html: string): Json | null {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype=["']application\/ld\+json["']/i.test(match[1])) {
      continue;
    }
    const parsed = parseJson(match[2]);
    for (const entry of jsonLdEntries(parsed)) {
      if (hasSchemaType(entry, "VideoObject") || hasSchemaType(entry, "SocialMediaPosting")) {
        return entry;
      }
    }
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(decodeHtml(value));
    } catch {
      return null;
    }
  }
}

function jsonLdEntries(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value.filter(object);
  }
  if (!object(value)) {
    return [];
  }
  return Array.isArray(value["@graph"]) ? value["@graph"].filter(object) : [value];
}

function hasSchemaType(value: Json, expected: string): boolean {
  const type = value["@type"];
  return type === expected || (Array.isArray(type) && type.includes(expected));
}

function linkedinItems(post: Json, html: string, id: string, referer: string): MediaItem[] {
  const headers = { referer, "user-agent": browserUserAgent() };
  if (hasSchemaType(post, "VideoObject")) {
    const url = bestVideoUrl(html) ?? string(post.contentUrl);
    return url
      ? [{ filename: filename(`linkedin_${id}.mp4`), headers, id, kind: "video", mime: "video/mp4", platform: "linkedin", url }]
      : [];
  }
  const url = imageUrl(post.image);
  return url
    ? [{ filename: filename(`linkedin_${id}.jpg`), headers, id, kind: "image", mime: "image/jpeg", platform: "linkedin", url }]
    : [];
}

function bestVideoUrl(html: string): string | null {
  const encoded = html.match(/<video\b[^>]*\bdata-sources=(["'])(.*?)\1[^>]*>/is)?.[2];
  if (!encoded) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeHtml(encoded));
  } catch {
    return null;
  }
  const sources = Array.isArray(parsed) ? parsed.filter(object) : [];
  const videos = sources.filter((source) => string(source.type) === "video/mp4" && string(source.src));
  const selected = videos.reduce<Json | null>((best, candidate) => {
    const bitrate = count(candidate["data-bitrate"]) ?? 0;
    const bestBitrate = best ? count(best["data-bitrate"]) ?? 0 : -1;
    return bitrate > bestBitrate ? candidate : best;
  }, null);
  return selected ? string(selected.src) : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return string(value);
  }
  if (Array.isArray(value)) {
    return value.map(imageUrl).find((url): url is string => Boolean(url)) ?? null;
  }
  return object(value) ? string(value.url) : null;
}

function interactionCount(value: unknown, action: string): number | undefined {
  const statistics = Array.isArray(value) ? value.filter(object) : object(value) ? [value] : [];
  const statistic = statistics.find((entry) => string(entry.interactionType)?.endsWith(`/${action}`));
  return statistic ? count(statistic.userInteractionCount) : undefined;
}

function linkedinHandle(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).pathname.match(/^\/(?:company|in|showcase)\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&(quot|amp|lt|gt|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (_entity, name: string, decimal: string, hex: string) => {
    switch (name.toLowerCase()) {
      case "quot":
        return '"';
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "#39":
      case "#x27":
        return "'";
      default:
        return String.fromCodePoint(decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16));
    }
  });
}
