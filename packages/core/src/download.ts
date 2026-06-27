import { assembleHls } from "./hls";
import { createNet, PostfetchError, type MediaItem, type Net, type PostfetchResult } from "./internal";
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
