/** A platform that {@link postfetch} can resolve. */
export type Platform = "facebook" | "instagram" | "linkedin" | "pinterest" | "reddit" | "soundcloud" | "tiktok" | "twitter" | "youtube";

/** The kind of a {@link MediaItem}. */
export type MediaKind = "audio" | "image" | "video";

/** A single resolved media file: a direct URL plus everything needed to fetch and name it. */
export type MediaItem = {
  /**
   * When present, this is a video whose audio is a separate stream: {@link MediaItem.url}
   * carries the video track and `audio.url` the audio track (DASH/CMAF hands them out
   * apart). {@link download}, {@link archive} and {@link toResponse} merge the two with
   * the bundled remuxer; callers that read `url` directly get the silent video.
   */
  audio?: { headers: HeadersInit; url: string };
  /** Suggested download filename. */
  filename: string;
  /** Headers required to fetch {@link MediaItem.url} from the CDN. */
  headers: HeadersInit;
  /**
   * When `true`, {@link MediaItem.url} (and `audio.url`, if set) are HLS media
   * playlists rather than direct files: {@link download} assembles their segments
   * into a fragmented MP4 before serving — and merges video with audio when both
   * are present. Callers that read `url` directly get the playlist, not the media.
   */
  hls?: boolean;
  /** Platform media id. */
  id: string;
  /** Whether this item is a video, image or audio file. */
  kind: MediaKind;
  /** MIME type of the media. */
  mime: string;
  /** The platform this item came from. */
  platform: Platform;
  /** Direct CDN URL of the media. */
  url: string;
};

/** The author of a post, normalized across platforms. */
export type PostAuthor = {
  /** Account handle (the `@username`), where the platform exposes one. */
  handle?: string;
  /** Display name, where it differs from the handle. */
  name?: string;
  /** Whether the account is verified, where the platform reports it. */
  verified?: boolean;
};

/**
 * Post metadata normalized across platforms. Every field is optional: an absent
 * field means the sources consulted did not expose it (never a fabricated
 * default — a missing count is `undefined`,
 * not `0`). All counts are non-negative. Platform-specific fields live in `extra`.
 */
export type PostMetadata = {
  /** Short headline, where the platform has one distinct from the body (Reddit, YouTube, Pinterest, SoundCloud). */
  title?: string;
  /** Body text: caption, tweet, description or self-text. */
  text?: string;
  /** Who posted it. */
  author?: PostAuthor;
  /** Publication time as an ISO 8601 string. */
  createdAt?: string;
  /** Positive reactions (likes, upvotes, favorites, diggs). */
  likeCount?: number;
  /** Number of comments or replies. */
  commentCount?: number;
  /** Genuine reshares (TikTok shares, retweets, reposts) — not saves. */
  shareCount?: number;
  /** Views or plays. */
  viewCount?: number;
  /** Whether the post is marked not-safe-for-work, where the platform reports it. */
  nsfw?: boolean;
};

/** Reddit-specific metadata. */
export type RedditExtra = {
  /** Subreddit the post belongs to, without the `r/` prefix. */
  subreddit?: string;
  /** Net score (upvotes minus downvotes); can be negative. */
  score?: number;
  /** Fraction of votes that are upvotes, from 0 to 1. */
  upvoteRatio?: number;
  /** Path of the post on reddit.com, starting with `/r/`. */
  permalink?: string;
};

/** TikTok-specific metadata. */
export type TiktokExtra = {
  /** Times the video was added to favorites. */
  saveCount?: number;
  /** Title of the sound used. */
  musicTitle?: string;
  /** Author of the sound used. */
  musicAuthor?: string;
  /** Two-letter region the video was created in. */
  region?: string;
  /** Video duration in seconds. */
  durationSeconds?: number;
};

/** X (Twitter)-specific metadata. */
export type TwitterExtra = {
  /** BCP 47 language tag detected for the tweet. */
  lang?: string;
  /** The post quoted by this post, when X includes it in the resolved payload. */
  quotedTweet?: TwitterQuotedTweet;
};

/** A quoted X post and its normalized metadata. */
export type TwitterQuotedTweet = {
  /** Status id of the quoted post. */
  id: string;
  /** Metadata belonging to the quoted post rather than the outer post. */
  metadata: PostMetadata & { extra?: TwitterExtra };
};

/** Instagram-specific metadata. */
export type InstagramExtra = {
  /** Product type, e.g. `clips` for a reel or `feed` for a feed post. */
  productType?: string;
  /** Whether the account hid its like and view counts. */
  countsHidden?: boolean;
  /** Tagged location name, when present. */
  location?: string;
};

/** YouTube-specific metadata. */
export type YoutubeExtra = {
  /** Channel id (`UC…`) of the uploader. */
  channelId?: string;
  /** Video duration in seconds. */
  durationSeconds?: number;
  /** Video keywords. */
  keywords?: string[];
};

/** SoundCloud-specific metadata. */
export type SoundcloudExtra = {
  /** Track genre, when set. */
  genre?: string;
  /** Track license, e.g. `all-rights-reserved`. */
  license?: string;
  /** Track duration in seconds. */
  durationSeconds?: number;
};

/** Pinterest-specific metadata. */
export type PinterestExtra = {
  /** Times the pin was saved (repinned). */
  saveCount?: number;
  /** Dominant color of the pin image, as a hex string. */
  dominantColor?: string;
  /** Outbound link the pin points to, when set. */
  outboundLink?: string;
};

/** The result of resolving a post: its platform, id, media items and metadata. */
export type PostfetchResult =
  | PlatformResult<"facebook", never>
  | PlatformResult<"instagram", InstagramExtra>
  | PlatformResult<"linkedin", never>
  | PlatformResult<"pinterest", PinterestExtra>
  | PlatformResult<"reddit", RedditExtra>
  | PlatformResult<"soundcloud", SoundcloudExtra>
  | PlatformResult<"tiktok", TiktokExtra>
  | PlatformResult<"twitter", TwitterExtra>
  | PlatformResult<"youtube", YoutubeExtra>;

/** One platform's variant of a {@link PostfetchResult}, carrying that platform's `extra` metadata shape. */
export type PlatformResult<P extends Platform, Extra> = {
  /** Suggested filename when zipping every item. */
  archiveFilename: string;
  /** Platform post/media id. */
  id: string;
  /** The post's media, in order. */
  items: MediaItem[];
  /** The platform the post came from. */
  platform: P;
  /** Normalized post metadata, when any was available. */
  metadata?: PostMetadata & {
    /** Platform-specific metadata not covered by the normalized fields. */
    extra?: Extra;
  };
};

export type Net = (url: string, init?: RequestInit, attempts?: number) => Promise<Response>;

export type ResolveContext = {
  net: Net;
  preferredWidth: number;
  /** Requested soft byte cap, for resolvers that can rank exact rendition sizes. */
  tryMaxBytes?: number;
  url: string;
};

/**
 * Why a post could not be resolved, when the platform makes the cause knowable.
 * Lets callers tell a user-facing limitation (age-gated, private, removed) apart
 * from a transient/technical failure.
 */
export type PostfetchReason =
  | "ageRestricted"
  | "private"
  | "loginRequired"
  | "deleted"
  | "notFound"
  | "rateLimited"
  | "unavailable";

/** An error carrying an HTTP status, so adapters can map failures onto responses. */
export class PostfetchError extends Error {
  /**
   * Create an error tagged with an HTTP status.
   *
   * @param status HTTP status that best describes the failure.
   * @param message Human-readable message.
   * @param reason Machine-readable cause, when the platform makes it knowable.
   */
  constructor(
    /** HTTP status that best describes the failure. */
    readonly status: number,
    message: string,
    /** Machine-readable cause, when the platform makes it knowable. */
    readonly reason?: PostfetchReason,
  ) {
    super(message);
    this.name = "PostfetchError";
  }
}

export type Json = Record<string, unknown>;

export function createNet(baseFetch: typeof fetch = globalThis.fetch): Net {
  return async function net(url, init = {}, attempts = 3): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await baseFetch(url, { ...init, signal: controller.signal });
        if (!retryable(response.status) || attempt === attempts) {
          return response;
        }
        await sleep(retryDelay(response, attempt));
      } catch (error) {
        lastError = error;
        if (attempt === attempts) {
          break;
        }
        await sleep(500 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("request failed");
  };
}

export function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function count(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

export function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = count(value);
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

export function isoFromDateString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function asUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new PostfetchError(400, "invalid url");
  }
}

export function filename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const time = Date.parse(retryAfter);
    if (!Number.isNaN(time) && time > Date.now()) {
      return time - Date.now();
    }
  }
  return Math.min(500 * 2 ** (attempt - 1), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
