import {
  asUrl,
  filename,
  number,
  object,
  string,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";

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

const browserCookie = "PREF=hl=en&tz=UTC; SOCS=CAI";

export async function resolveYoutube(input: ResolveContext): Promise<PostfetchResult> {
  const id = youtubeVideoId(input.url);
  if (!id) {
    throw new Error("YouTube video id not found");
  }
  const session = await youtubeSession(input.net, id);
  const response = await input.net("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    body: JSON.stringify(playerBody(id, session)),
    headers: playerHeaders(session),
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
    headers: { "user-agent": androidVrClient.userAgent },
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "youtube",
    url: format,
  };
  return { archiveFilename: filename(`youtube_${id}.zip`), id, items: [media], platform: "youtube" };
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
