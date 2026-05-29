export type Platform = "instagram" | "tiktok" | "youtube";

export type Input = {
  platform: Platform | "auto";
  preferredWidth: number;
  url: string;
};

export type MediaKind = "audio" | "image" | "video";

export type MediaSource = {
  filename: string;
  headers: HeadersInit;
  id: string;
  kind: MediaKind;
  mime: string;
  platform: Platform;
  url: string;
};

export type MediaResult = {
  archiveFilename: string;
  id: string;
  items: MediaSource[];
  platform: Platform;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Json = Record<string, unknown>;

export const tiktokLambdaUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const tiktokPageUserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0";

export const instagramUserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0";

export async function fetchRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
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
    throw new HttpError(400, "invalid url");
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
