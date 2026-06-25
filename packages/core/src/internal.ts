/** A platform that {@link postfetch} can resolve. */
export type Platform = "facebook" | "instagram" | "tiktok" | "twitter" | "youtube";

/** The kind of a {@link MediaItem}. */
export type MediaKind = "audio" | "image" | "video";

/** A single resolved media file: a direct URL plus everything needed to fetch and name it. */
export type MediaItem = {
  /** Suggested download filename. */
  filename: string;
  /** Headers required to fetch {@link MediaItem.url} from the CDN. */
  headers: HeadersInit;
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

/** The result of resolving a post: its platform, id and one or more media items. */
export type PostfetchResult = {
  /** Suggested filename when zipping every item. */
  archiveFilename: string;
  /** Platform post/media id. */
  id: string;
  /** The post's media, in order. */
  items: MediaItem[];
  /** The platform the post came from. */
  platform: Platform;
};

export type Net = (url: string, init?: RequestInit, attempts?: number) => Promise<Response>;

export type ResolveContext = {
  net: Net;
  preferredWidth: number;
  url: string;
};

/** An error carrying an HTTP status, so adapters can map failures onto responses. */
export class PostfetchError extends Error {
  /**
   * Create an error tagged with an HTTP status.
   *
   * @param status HTTP status that best describes the failure.
   * @param message Human-readable message.
   */
  constructor(
    /** HTTP status that best describes the failure. */
    readonly status: number,
    message: string,
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
