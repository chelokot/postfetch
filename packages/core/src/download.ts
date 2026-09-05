import { assembleHls } from "./hls";
import { createNet, PostfetchError, type MediaItem, type Net, type PostfetchResult } from "./internal";
import { prepareMp4 } from "./mp4-remux";
import { mergeAudioVideo } from "./remux";
import { zip } from "./zip";

// A muxed item carries a separate audio stream; an HLS item carries playlists.
// Either way the bytes must be assembled in-process rather than streamed.
function buffered(item: MediaItem): boolean {
  return Boolean(item.audio) || item.hls === true;
}

/** Options for {@link download}, {@link archive} and {@link toResponse}. */
export type DownloadOptions = {
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Options for {@link downloadBlob}. */
export type DownloadBlobOptions = DownloadOptions & {
  /** Command used for opt-in MP4 remuxing. Defaults to `ffmpeg` from `PATH`. */
  ffmpegPath?: string;
  /** Command used to inspect remuxed MP4s. Defaults to `ffprobe` from `PATH`. */
  ffprobePath?: string;
  /** Headers required by the resolved media URL. */
  headers?: HeadersInit;
  /** Normalize an MP4 container with FFmpeg. Defaults to `false`. */
  remux?: boolean;
};

/** A normalized video and upload metadata produced by `remux: true`. */
export type RemuxedVideo = {
  blob: Blob;
  duration: number;
  height: number;
  thumbnail: Blob;
  width: number;
};

/** A zip archive produced by {@link archive}. */
export type Archive = {
  /** The zip bytes (store mode, built in-process). */
  bytes: Uint8Array;
  /** Suggested download filename. */
  filename: string;
  /** Always `"application/zip"`. */
  mime: "application/zip";
};

/**
 * Fetch a single media item, ready to stream or buffer. A plain item streams
 * straight from its CDN; a muxed item (one with {@link MediaItem.audio}) is
 * downloaded as two streams and merged in-process, so its body is buffered.
 *
 * @param item A {@link MediaItem} from a {@link PostfetchResult}.
 * @param options See {@link DownloadOptions}.
 * @returns The upstream `Response`, or a buffered `Response` of the merged file.
 * @throws {PostfetchError} If the CDN responds with a non-OK status.
 *
 * @example
 * ```ts
 * const result = await postfetch(url);
 * await Bun.write(result.items[0].filename, await download(result.items[0]));
 * ```
 */
export async function download(item: MediaItem, options: DownloadOptions = {}): Promise<Response> {
  const net = createNet(options.fetch ?? globalThis.fetch);
  if (buffered(item)) {
    const bytes = await itemBytes(net, item);
    return new Response(toArrayBuffer(bytes), { headers: { "content-length": String(bytes.length), "content-type": item.mime } });
  }
  const response = await net(item.url, { headers: item.headers });
  if (!response.ok || !response.body) {
    throw new PostfetchError(502, `download failed: ${response.status}`);
  }
  return response;
}

/**
 * Download an already-resolved media URL as a Blob.
 *
 * This is useful for consumers that need to upload media themselves instead of
 * passing its URL to a third party. When the resolved {@link MediaItem} carries
 * required CDN headers, pass them in the options object. Set `remux: true` to
 * normalize an MP4 with an FFmpeg stream copy; if FFmpeg is unavailable or the
 * remux or metadata extraction fails, the operation throws.
 *
 * @param url A direct media URL returned by a resolver.
 * @param options Headers, fetch implementation and opt-in remux behavior.
 * @returns A Blob, or with `remux: true`, the normalized video and its metadata.
 *
 * @example Upload a video with FormData
 * ```ts
 * const [media] = (await postfetch(sourceUrl)).items;
 * const video = await downloadBlob(media.url, { headers: media.headers, remux: true });
 * form.append("video", video.blob, media.filename);
 * form.append("thumbnail", video.thumbnail, "thumbnail.jpg");
 * ```
 */
export async function downloadBlob(
  url: string,
  options: DownloadBlobOptions & { remux: true },
): Promise<RemuxedVideo>;
export async function downloadBlob(
  url: string,
  options?: DownloadBlobOptions & { remux?: false },
): Promise<Blob>;
/** @deprecated Pass headers and fetch in a single {@link DownloadBlobOptions} object. */
export async function downloadBlob(url: string, headers?: HeadersInit, options?: DownloadOptions): Promise<Blob>;
export async function downloadBlob(
  url: string,
  optionsOrHeaders: DownloadBlobOptions | HeadersInit = {},
  legacyOptions: DownloadOptions = {},
): Promise<Blob | RemuxedVideo> {
  const modern = isDownloadBlobOptions(optionsOrHeaders);
  const options = modern ? optionsOrHeaders : legacyOptions;
  const headers = modern ? optionsOrHeaders.headers ?? {} : optionsOrHeaders;
  const net = createNet(options.fetch ?? globalThis.fetch);
  const response = await net(url, { headers });
  if (!response.ok || !response.body) {
    throw new PostfetchError(502, `download failed: ${response.status}`);
  }
  const blob = await response.blob();
  if (!modern || optionsOrHeaders.remux !== true) {
    return blob;
  }
  const prepared = await prepareMp4(
    new Uint8Array(await blob.arrayBuffer()),
    optionsOrHeaders.ffmpegPath,
    optionsOrHeaders.ffprobePath,
  );
  if (!prepared) {
    throw new PostfetchError(500, "MP4 remux or metadata extraction failed");
  }
  return {
    blob: new Blob([toArrayBuffer(prepared.bytes)], { type: blob.type || "video/mp4" }),
    duration: prepared.duration,
    height: prepared.height,
    thumbnail: new Blob([toArrayBuffer(prepared.thumbnail)], { type: "image/jpeg" }),
    width: prepared.width,
  };
}

function isDownloadBlobOptions(value: DownloadBlobOptions | HeadersInit): value is DownloadBlobOptions {
  if (value instanceof Headers || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    ("headers" in candidate && typeof candidate.headers !== "string") ||
    typeof candidate.remux === "boolean" ||
    typeof candidate.ffmpegPath === "string" ||
    typeof candidate.ffprobePath === "string" ||
    typeof candidate.fetch === "function"
  );
}

/**
 * Download every item of a result and zip them in-process (store mode).
 *
 * @param result A {@link PostfetchResult}.
 * @param options See {@link DownloadOptions}.
 * @returns The zip bytes and a suggested filename.
 */
export async function archive(result: PostfetchResult, options: DownloadOptions = {}): Promise<Archive> {
  const net = createNet(options.fetch ?? globalThis.fetch);
  const files = await Promise.all(
    result.items.map(async (item) => ({ data: await itemBytes(net, item), name: item.filename })),
  );
  return { bytes: zip(files), filename: result.archiveFilename, mime: "application/zip" };
}

/**
 * Turn a result into a ready-to-serve `Response`: a single item is streamed as
 * its file (or, when muxed, merged and buffered), multiple items become a zip.
 * Sets `content-disposition` and the `x-media-*` headers. This is what the
 * showcase server and templates return.
 *
 * @param result A {@link PostfetchResult}.
 * @param options See {@link DownloadOptions}.
 * @returns A `Response` a server or edge function can return directly.
 */
export async function toResponse(result: PostfetchResult, options: DownloadOptions = {}): Promise<Response> {
  if (result.items.length === 1) {
    return singleResponse(result.items[0], options);
  }
  return archiveResponse(result, options);
}

async function singleResponse(item: MediaItem, options: DownloadOptions): Promise<Response> {
  if (buffered(item)) {
    const net = createNet(options.fetch ?? globalThis.fetch);
    const bytes = await itemBytes(net, item);
    return new Response(toArrayBuffer(bytes), {
      headers: {
        "content-disposition": `attachment; filename="${item.filename}"`,
        "content-length": String(bytes.length),
        "content-type": item.mime,
        "x-media-count": "1",
        "x-media-id": item.id,
        "x-media-kind": item.kind,
        "x-media-platform": item.platform,
      },
    });
  }
  const media = await download(item, options);
  const headers = new Headers({
    "content-disposition": `attachment; filename="${item.filename}"`,
    "content-type": media.headers.get("content-type") ?? item.mime,
    "x-media-count": "1",
    "x-media-id": item.id,
    "x-media-kind": item.kind,
    "x-media-platform": item.platform,
  });
  const length = media.headers.get("content-length");
  if (length) {
    headers.set("content-length", length);
  }
  return new Response(media.body, { headers });
}

async function archiveResponse(result: PostfetchResult, options: DownloadOptions): Promise<Response> {
  const { bytes, filename } = await archive(result, options);
  return new Response(toArrayBuffer(bytes), {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
      "content-type": "application/zip",
      "x-media-count": String(result.items.length),
      "x-media-id": result.id,
      "x-media-platform": result.platform,
    },
  });
}

async function itemBytes(net: Net, item: MediaItem): Promise<Uint8Array> {
  if (item.hls) {
    const video = await assembleHls(net, item.url, item.headers);
    if (item.audio) {
      return mergeAudioVideo(video, await assembleHls(net, item.audio.url, item.audio.headers));
    }
    return video;
  }
  if (item.audio) {
    return mergedBytes(net, item, item.audio);
  }
  return fetchBytes(net, item.url, item.headers);
}

// A muxed item's two streams are fetched in parallel and merged in a single pass.
async function mergedBytes(net: Net, item: MediaItem, audio: NonNullable<MediaItem["audio"]>): Promise<Uint8Array> {
  const [video, audioBytes] = await Promise.all([
    fetchBytes(net, item.url, item.headers),
    fetchBytes(net, audio.url, audio.headers),
  ]);
  return mergeAudioVideo(video, audioBytes);
}

async function fetchBytes(net: Net, url: string, headers: HeadersInit): Promise<Uint8Array> {
  const response = await net(url, { headers });
  if (!response.ok) {
    throw new PostfetchError(502, `download failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
