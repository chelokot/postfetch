import {
  asUrl,
  count,
  filename,
  isoFromDateString,
  number,
  object,
  string,
  type PostMetadata,
  type YoutubeExtra,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";
import { parseMaster } from "./hls";

type YoutubeSession = {
  cookie: string;
  signatureTimestamp: number;
  visitorData: string;
};

const androidVrClient = {
  name: "ANDROID_VR",
  number: "28",
  userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  version: "1.65.10",
};

const visionOsClient = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  osName: "visionOS",
  osVersion: "26.5.23O471",
};

const browserCookie = "PREF=hl=en&tz=UTC; SOCS=CAI";

export async function resolveYoutube(input: ResolveContext): Promise<PostfetchResult> {
  const id = youtubeVideoId(input.url);
  if (!id) {
    throw new Error("YouTube video id not found");
  }
  let session: YoutubeSession | undefined;
  try {
    session = await youtubeSession(input.net, id);
    const payload = await youtubePlayer(input.net, playerBody(id, session), playerHeaders(session));
    const streams = selectStreams(payload, input.preferredWidth);
    if (!streams) {
      throw new Error("YouTube mp4 stream not found");
    }
    const headers = { "user-agent": androidVrClient.userAgent };
    // A successful player response can still contain CDN URLs that return 403.
    // Check the actual GET and cancel its body: HEAD/Range probes can succeed
    // even when YouTube rejects the full download.
    await Promise.all([streams.video, streams.audio].filter((url): url is string => url !== null).map((url) => probeStream(input.net, url, headers)));
    return youtubeResult(id, payload, streams, headers);
  } catch (primaryError) {
    try {
      return await resolveVisionOs(input, id, session?.visitorData);
    } catch (fallbackError) {
      const message = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new Error(`YouTube resolution failed: ${message(primaryError)}; visionOS HLS: ${message(fallbackError)}`, { cause: fallbackError });
    }
  }
}

async function youtubePlayer(net: Net, body: Json, headers: HeadersInit): Promise<unknown> {
  const response = await net("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    body: JSON.stringify(body), headers, method: "POST",
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
  return payload;
}

function youtubeResult(
  id: string,
  payload: unknown,
  streams: { video: string; audio: string | null; hls?: boolean },
  headers: HeadersInit,
): PostfetchResult {
  const title = object(payload) && object(payload.videoDetails) ? string(payload.videoDetails.title) : null;
  const media: MediaItem = {
    filename: filename(`youtube_${title ?? id}_${id}.mp4`),
    headers,
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "youtube",
    url: streams.video,
    ...(streams.hls ? { hls: true } : {}),
    ...(streams.audio ? { audio: { headers, url: streams.audio } } : {}),
  };
  return { archiveFilename: filename(`youtube_${id}.zip`), id, items: [media], metadata: youtubeMetadata(payload), platform: "youtube" };
}

async function probeStream(net: Net, url: string, headers: HeadersInit): Promise<void> {
  const response = await net(url, { headers }, 1);
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`YouTube stream failed: ${response.status}`);
  }
}

async function resolveVisionOs(input: ResolveContext, id: string, visitorData?: string): Promise<PostfetchResult> {
  const headers = { "user-agent": visionOsClient.userAgent };
  const payload = await youtubePlayer(input.net, {
    videoId: id,
    contentCheckOk: true,
    racyCheckOk: true,
    context: { client: { ...visionOsClient, hl: "en", gl: "US", ...(visitorData ? { visitorData } : {}) } },
  }, {
    ...headers,
    "content-type": "application/json",
    "x-youtube-client-name": "101",
    "x-youtube-client-version": visionOsClient.clientVersion,
    ...(visitorData ? { "x-goog-visitor-id": visitorData } : {}),
  });
  const streaming = object(payload) && object(payload.streamingData) ? payload.streamingData : null;
  const manifestUrl = streaming ? string(streaming.hlsManifestUrl) : null;
  if (!manifestUrl) {
    throw new Error("YouTube HLS manifest not found");
  }
  const response = await input.net(manifestUrl, { headers });
  if (!response.ok) {
    throw new Error(`YouTube HLS manifest failed: ${response.status}`);
  }
  const master = parseMaster(await response.text(), manifestUrl);
  // YouTube's AVC HLS variants use MPEG-TS. VP9/AV1 variants use fMP4 and
  // work with the bundled box-level merger. Require the paired AAC-LC track.
  const variants = master.variants.filter((variant) =>
    /(?:^|,)(?:vp09|av01)\./i.test(variant.codecs ?? "") &&
    /(?:^|,)mp4a\.40\.2(?:,|$)/i.test(variant.codecs ?? "") &&
    variant.audioGroup && master.audio[variant.audioGroup]
  ).sort((left, right) =>
    Math.abs(left.width - input.preferredWidth) - Math.abs(right.width - input.preferredWidth) || right.bandwidth - left.bandwidth
  );
  const variant = variants[0];
  if (!variant?.audioGroup) {
    throw new Error("YouTube fragmented MP4 HLS video with AAC audio not found");
  }
  const playlist = await input.net(variant.url, { headers });
  if (!playlist.ok) {
    throw new Error(`YouTube HLS playlist failed: ${playlist.status}`);
  }
  if (!(await playlist.text()).includes("#EXT-X-MAP:")) {
    throw new Error("YouTube HLS video is not fragmented MP4");
  }
  return youtubeResult(id, payload, { video: variant.url, audio: master.audio[variant.audioGroup], hls: true }, headers);
}

export function youtubeMetadata(payload: unknown): PostMetadata & { extra?: YoutubeExtra } {
  const details = object(payload) && object(payload.videoDetails) ? payload.videoDetails : null;
  const renderer =
    object(payload) && object(payload.microformat) && object(payload.microformat.playerMicroformatRenderer)
      ? payload.microformat.playerMicroformatRenderer
      : null;
  const author = details ? string(details.author) : null;
  const keywords =
    details && Array.isArray(details.keywords)
      ? details.keywords.filter((keyword): keyword is string => typeof keyword === "string")
      : [];
  return {
    title: details ? string(details.title) ?? undefined : undefined,
    text: details ? string(details.shortDescription) ?? undefined : undefined,
    author: author ? { name: author } : undefined,
    createdAt: renderer ? isoFromDateString(renderer.publishDate) : undefined,
    viewCount: details ? count(details.viewCount) : undefined,
    extra: {
      channelId: details ? string(details.channelId) ?? undefined : undefined,
      durationSeconds: details ? count(details.lengthSeconds) : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
    },
  };
}

// Adaptive H.264 video and AAC audio go up to 1080p with direct URLs; merging them
// beats the progressive formats (capped at 360-720p). The progressive single-file
// stream is the fallback when a separate-stream pair is unavailable.
function selectStreams(payload: unknown, preferredWidth: number): { video: string; audio: string | null } | null {
  const adaptive = adaptiveFormats(payload);
  const video = bestVideo(adaptive, preferredWidth);
  const audio = bestAudio(adaptive);
  if (video && audio) {
    return { video, audio };
  }
  const progressive = selectFormat(payload);
  return progressive ? { video: progressive, audio: null } : null;
}

function adaptiveFormats(payload: unknown): Json[] {
  const root = object(payload) ? payload : null;
  const streaming = root && object(root.streamingData) ? root.streamingData : null;
  return streaming && Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats.filter(object) : [];
}

function bestVideo(formats: Json[], preferredWidth: number): string | null {
  const candidates = formats.filter((format) => {
    const mimeType = string(format.mimeType);
    return Boolean(string(format.url)) && mimeType?.startsWith("video/mp4") === true && mimeType.includes("avc1");
  });
  const best = candidates.reduce<Json | null>((current, format) => {
    if (!current) {
      return format;
    }
    const width = number(format.width) ?? 0;
    const currentWidth = number(current.width) ?? 0;
    return Math.abs(width - preferredWidth) < Math.abs(currentWidth - preferredWidth) ? format : current;
  }, null);
  return best ? string(best.url) : null;
}

function bestAudio(formats: Json[]): string | null {
  const candidates = formats.filter((format) => Boolean(string(format.url)) && string(format.mimeType)?.startsWith("audio/mp4") === true);
  const best = candidates.reduce<Json | null>((current, format) => {
    if (!current) {
      return format;
    }
    return (number(format.bitrate) ?? 0) > (number(current.bitrate) ?? 0) ? format : current;
  }, null);
  return best ? string(best.url) : null;
}

function playerBody(id: string, session: YoutubeSession): Json {
  return {
    contentCheckOk: true,
    context: {
      client: {
        androidSdkVersion: 32,
        clientName: androidVrClient.name,
        clientVersion: androidVrClient.version,
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        gl: "US",
        hl: "en",
        osName: "Android",
        osVersion: "12L",
        timeZone: "UTC",
        userAgent: androidVrClient.userAgent,
        utcOffsetMinutes: 0,
        visitorData: session.visitorData,
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        signatureTimestamp: session.signatureTimestamp,
      },
    },
    racyCheckOk: true,
    videoId: id,
  };
}

async function youtubeSession(net: Net, id: string): Promise<YoutubeSession> {
  const response = await net(`https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-us,en;q=0.5",
      cookie: browserCookie,
      "sec-fetch-mode": "navigate",
      "user-agent": browserUserAgent(),
    },
  });
  if (!response.ok) {
    throw new Error(`YouTube page failed: ${response.status}`);
  }
  const page = await response.text();
  const visitorData = string(page.match(/"visitorData":"([^"]+)"/)?.[1]);
  if (!visitorData) {
    throw new Error("YouTube visitor data not found");
  }
  const playerPath = string(page.match(/"jsUrl":"([^"]+)"/)?.[1]) ?? string(page.match(/"PLAYER_JS_URL":"([^"]+)"/)?.[1]);
  if (!playerPath) {
    throw new Error("YouTube player url not found");
  }
  return {
    cookie: youtubeCookie(response.headers),
    signatureTimestamp: await signatureTimestamp(net, playerPath),
    visitorData,
  };
}

function playerHeaders(session: YoutubeSession): Headers {
  return new Headers({
    "content-type": "application/json",
    cookie: `${browserCookie}; ${session.cookie}`,
    origin: "https://www.youtube.com",
    "user-agent": androidVrClient.userAgent,
    "x-goog-visitor-id": session.visitorData,
    "x-youtube-client-name": androidVrClient.number,
    "x-youtube-client-version": androidVrClient.version,
  });
}

function youtubeCookie(headers: Headers): string {
  const readable = headers as Headers & { getSetCookie?: () => string[] };
  const fallback = headers.get("set-cookie");
  const cookieHeaders = readable.getSetCookie ? readable.getSetCookie() : fallback ? [fallback] : [];
  return cookieHeaders
    .map((header) => string(header.split(";", 1)[0]))
    .filter(string)
    .join("; ");
}

async function signatureTimestamp(net: Net, playerPath: string): Promise<number> {
  const response = await net(new URL(playerPath, "https://www.youtube.com").toString(), {
    headers: { "user-agent": browserUserAgent() },
  });
  if (!response.ok) {
    throw new Error(`YouTube player failed: ${response.status}`);
  }
  const player = await response.text();
  const timestamp = number(Number(player.match(/signatureTimestamp[:=](\d+)/)?.[1] ?? player.match(/sts[:=](\d+)/)?.[1]));
  if (!timestamp) {
    throw new Error("YouTube signature timestamp not found");
  }
  return timestamp;
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
