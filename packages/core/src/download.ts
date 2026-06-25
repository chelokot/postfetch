import { createNet, PostfetchError, type MediaItem, type PostfetchResult } from "./internal";
import { zip } from "./zip";

export type DownloadOptions = {
  fetch?: typeof fetch;
};

export type Archive = {
  bytes: Uint8Array;
  filename: string;
  mime: "application/zip";
};

export async function download(item: MediaItem, options: DownloadOptions = {}): Promise<Response> {
  const net = createNet(options.fetch ?? globalThis.fetch);
  const response = await net(item.url, { headers: item.headers });
  if (!response.ok || !response.body) {
    throw new PostfetchError(502, `download failed: ${response.status}`);
  }
  return response;
}

export async function archive(result: PostfetchResult, options: DownloadOptions = {}): Promise<Archive> {
  const net = createNet(options.fetch ?? globalThis.fetch);
  const files = await Promise.all(
    result.items.map(async (item) => {
      const response = await net(item.url, { headers: item.headers });
      if (!response.ok) {
        throw new PostfetchError(502, `download failed: ${response.status}`);
      }
      return { data: new Uint8Array(await response.arrayBuffer()), name: item.filename };
    }),
  );
  return { bytes: zip(files), filename: result.archiveFilename, mime: "application/zip" };
}

export async function toResponse(result: PostfetchResult, options: DownloadOptions = {}): Promise<Response> {
  if (result.items.length === 1) {
    return singleResponse(result.items[0], options);
  }
  return archiveResponse(result, options);
}

async function singleResponse(item: MediaItem, options: DownloadOptions): Promise<Response> {
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
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
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
