import {
  asUrl,
  filename,
  number,
  object,
  string,
  type ResolveContext,
  type Json,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { youtubeClient } from "./fingerprint";

const apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

export async function resolveYoutube(input: ResolveContext): Promise<PostfetchResult> {
  const id = youtubeVideoId(input.url);
  if (!id) {
    throw new Error("YouTube video id not found");
  }
  const client = youtubeClient();
  const response = await input.net(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    body: JSON.stringify(playerBody(id, client.clientVersion)),
    headers: {
      "content-type": "application/json",
      "user-agent": client.userAgent,
      "x-youtube-client-name": "3",
      "x-youtube-client-version": client.clientVersion,
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`YouTube player failed: ${response.status}`);
  }
  const payload = await response.json();
  const status = object(payload) && object(payload.playabilityStatus) ? string(payload.playabilityStatus.status) : null;
  if (status !== "OK") {
    const reason = object(payload) && object(payload.playabilityStatus) ? string(payload.playabilityStatus.reason) : null;
    throw new Error(reason ?? "YouTube video unavailable");
  }
  const format = selectFormat(payload);
  if (!format) {
    throw new Error("YouTube progressive mp4 not found");
  }
  const title = object(payload) && object(payload.videoDetails) ? string(payload.videoDetails.title) : null;
  const media: MediaItem = {
    filename: filename(`youtube_${title ?? id}_${id}.mp4`),
    headers: { "user-agent": client.userAgent },
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "youtube",
    url: format,
  };
  return { archiveFilename: filename(`youtube_${id}.zip`), id, items: [media], platform: "youtube" };
}

function playerBody(id: string, clientVersion: string): Json {
  return {
    contentCheckOk: true,
    context: {
      client: {
        androidSdkVersion: 35,
        clientName: "ANDROID",
        clientVersion,
        gl: "US",
        hl: "en",
        osName: "Android",
        osVersion: "15",
      },
    },
    racyCheckOk: true,
    videoId: id,
  };
}

export function youtubeVideoId(input: string): string | null {
  const url = asUrl(input);
  if (url.hostname === "youtu.be") {
    return cleanId(url.pathname.split("/").filter(Boolean)[0]);
  }
  const fromQuery = cleanId(url.searchParams.get("v"));
  if (fromQuery) {
    return fromQuery;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.findIndex((part) => part === "shorts" || part === "live" || part === "embed");
  return index >= 0 ? cleanId(parts[index + 1]) : null;
}

function cleanId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

function selectFormat(payload: unknown): string | null {
  const root = object(payload) ? payload : null;
  const streaming = root && object(root.streamingData) ? root.streamingData : null;
  const formats = streaming && Array.isArray(streaming.formats) ? streaming.formats.filter(object) : [];
  const mp4 = formats
    .filter((format) => string(format.url) && string(format.mimeType)?.startsWith("video/mp4"))
    .sort((left, right) => height(right) - height(left));
  return mp4[0] ? string(mp4[0].url) : null;
}

function height(format: Json): number {
  return number(format.height) ?? Number(string(format.qualityLabel)?.match(/(\d+)p/)?.[1] ?? 0);
}
