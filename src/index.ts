import { HttpError, asUrl, fetchRetry, type Input, type MediaResult, type MediaSource, type Platform } from "./core";
import { resolveInstagram } from "./instagram";
import { resolveTiktok } from "./tiktok";
import { resolveYoutube } from "./youtube";
import { zip } from "./zip";

const port = 3040;

Bun.serve({
  idleTimeout: 120,
  port,
  async fetch(request) {
    try {
      const input = await readInput(request);
      const result = await resolve(input);
      if (result.items.length === 1) {
        return downloadOne(result.items[0]);
      }
      return downloadArchive(result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      return new Response(`${message}\n`, { headers: { "content-type": "text/plain; charset=utf-8" }, status });
    }
  },
});

console.info(`http://localhost:${port}/?url=`);

async function downloadOne(source: MediaSource): Promise<Response> {
  const media = await fetchRetry(source.url, { headers: source.headers });
  if (!media.ok || !media.body) {
    throw new HttpError(502, `download failed: ${media.status}`);
  }
  const headers = new Headers({
    "content-disposition": `attachment; filename="${source.filename}"`,
    "content-type": media.headers.get("content-type") ?? source.mime,
    "x-media-count": "1",
    "x-media-id": source.id,
    "x-media-kind": source.kind,
    "x-media-platform": source.platform,
  });
  const length = media.headers.get("content-length");
  if (length) {
    headers.set("content-length", length);
  }
  return new Response(media.body, { headers });
}

async function downloadArchive(result: MediaResult): Promise<Response> {
  const files = await Promise.all(
    result.items.map(async (item) => {
      const media = await fetchRetry(item.url, { headers: item.headers });
      if (!media.ok) {
        throw new HttpError(502, `download failed: ${media.status}`);
      }
      return { data: new Uint8Array(await media.arrayBuffer()), name: item.filename };
    }),
  );
  const body = zip(files);
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Response(bytes, {
    headers: {
      "content-disposition": `attachment; filename="${result.archiveFilename}"`,
      "content-length": String(body.length),
      "content-type": "application/zip",
      "x-media-count": String(result.items.length),
      "x-media-id": result.id,
      "x-media-platform": result.platform,
    },
  });
}

async function readInput(request: Request): Promise<Input> {
  const requestUrl = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const raw = requestUrl.searchParams.get("url") ?? body;
  if (!raw || raw.trim().length === 0) {
    throw new HttpError(400, "pass ?url= or POST a URL");
  }
  return {
    platform: platform(requestUrl.searchParams.get("platform")),
    preferredWidth: positiveInt(requestUrl.searchParams.get("width")) ?? 720,
    url: raw.trim(),
  };
}

async function resolve(input: Input): Promise<MediaResult> {
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

function detect(input: string): Platform {
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

function platform(value: string | null): Input["platform"] {
  if (value === "instagram" || value === "tiktok" || value === "youtube") {
    return value;
  }
  return "auto";
}

function positiveInt(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
