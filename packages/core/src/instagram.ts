import {
  asUrl,
  filename,
  number,
  object,
  string,
  type ResolveContext,
  type Net,
  type Json,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserFingerprint, browserUserAgent, instagramAppUserAgent, navigationHeaders } from "./fingerprint";

const appId = "936619743392459";

function mobileHeaders(): Record<string, string> {
  return {
    "accept-language": "en-US",
    "content-length": "0",
    "user-agent": instagramAppUserAgent(),
    "x-fb-client-ip": "True",
    "x-fb-http-engine": "Liger",
    "x-fb-server-cluster": "True",
    "x-ig-app-locale": "en_US",
    "x-ig-device-locale": "en_US",
    "x-ig-mapped-locale": "en_US",
  };
}

function embedHeaders(): Record<string, string> {
  const fingerprint = browserFingerprint();
  return {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": fingerprint.acceptLanguage,
    "Cache-Control": "max-age=0",
    Dnt: "1",
    Priority: "u=0, i",
    "Sec-Ch-Ua": fingerprint.secChUa,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": fingerprint.secChUaPlatform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": fingerprint.userAgent,
  };
}

export async function resolveInstagram(input: ResolveContext): Promise<PostfetchResult> {
  const code = shortcode(input.url);
  const media =
    (await pageMedia(input.net, code, input.preferredWidth)) ??
    (await mobileMedia(input.net, code, input.preferredWidth)) ??
    (await embedMedia(input.net, code)) ??
    (await graphqlMedia(input.net, code));
  if (!media) {
    throw new Error("Instagram media not found");
  }
  const items = mediaItems(media, code, input.preferredWidth);
  if (items.length === 0) {
    throw new Error("Instagram media url not found");
  }
  return { archiveFilename: filename(`instagram_${code}.zip`), id: code, items, platform: "instagram" };
}

function shortcode(input: string): string {
  const path = asUrl(input).pathname.split("/").filter(Boolean);
  const index = path.findIndex((part) => part === "p" || part === "reel" || part === "reels" || part === "tv");
  const code = index >= 0 ? path[index + 1] : path[path.length - 1];
  if (!code) {
    throw new Error("Instagram shortcode not found");
  }
  return code;
}

async function pageMedia(net: Net, code: string, preferredWidth: number): Promise<Json | null> {
  const response = await net(`https://www.instagram.com/p/${code}/`, { headers: navigationHeaders() });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const media = inlineMedia(html, code);
  return media && mediaItems(media, code, preferredWidth).length > 0 ? media : null;
}

function inlineMedia(html: string, code: string): Json | null {
  for (const match of html.matchAll(/<script type="application\/json"[^>]*>(.*?)<\/script>/gs)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const media = searchMedia(parsed, code);
    if (media) {
      return media;
    }
  }
  return null;
}

function searchMedia(node: unknown, code: string): Json | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const media = searchMedia(child, code);
      if (media) {
        return media;
      }
    }
    return null;
  }
  if (!object(node)) {
    return null;
  }
  const hasMedia =
    Array.isArray(node.video_versions) ||
    Array.isArray(node.carousel_media) ||
    (object(node.image_versions2) && Array.isArray(node.image_versions2.candidates));
  if (hasMedia && node.code === code) {
    return node;
  }
  for (const key in node) {
    const media = searchMedia(node[key], code);
    if (media) {
      return media;
    }
  }
  return null;
}

async function mobileMedia(net: Net, code: string, preferredWidth: number): Promise<Json | null> {
  const id = await mediaId(net, code);
  if (!id) {
    return null;
  }
  const media = await mobileInfo(net, id);
  return media && mediaItems(media, code, preferredWidth).length > 0 ? media : null;
}

async function mediaId(net: Net, code: string): Promise<string | null> {
  const url = new URL("https://i.instagram.com/api/v1/oembed/");
  url.searchParams.set("url", `https://www.instagram.com/p/${code}/`);
  const response = await net(url.href, { headers: mobileHeaders() }, 1);
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  return object(payload) ? string(payload.media_id) : null;
}

async function mobileInfo(net: Net, mediaId: string): Promise<Json | null> {
  const response = await net(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: mobileHeaders(),
  }, 1);
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const items = object(payload) && Array.isArray(payload.items) ? payload.items : [];
  const first = items[0];
  return object(first) ? first : null;
}

async function embedMedia(net: Net, code: string): Promise<Json | null> {
  const response = await net(`https://www.instagram.com/p/${code}/embed/captioned/`, {
    headers: embedHeaders(),
  });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const init = html.match(/"init",\[\],\[(.*?)\]\],/s)?.[1];
  if (!init) {
    return null;
  }
  const parsed: unknown = JSON.parse(init);
  const contextJson = object(parsed) ? string(parsed.contextJSON) : null;
  if (!contextJson) {
    return null;
  }
  const context: unknown = JSON.parse(contextJson);
  if (!object(context)) {
    return null;
  }
  const embedded = object(context.context) && object(context.context.media) ? context.context.media : null;
  const gqlMedia = gqlShortcodeMedia(context);
  return embedded ?? gqlMedia;
}

async function graphqlMedia(net: Net, code: string): Promise<Json | null> {
  const params = await graphqlParams(net, code);
  if (!params) {
    return null;
  }
  const body = new URLSearchParams({
    ...params.body,
    doc_id: "8845758582119845",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
    server_timestamps: "true",
    variables: JSON.stringify({
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
      shortcode: code,
    }),
  });
  const response = await net("https://www.instagram.com/graphql/query", {
    body,
    headers: {
      ...embedHeaders(),
      ...params.headers,
      "X-FB-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const data = object(payload) && object(payload.data) ? payload.data : null;
  return data ? gqlShortcodeMedia(data) : null;
}

async function graphqlParams(net: Net, code: string): Promise<{ body: Record<string, string>; headers: Record<string, string> } | null> {
  const response = await net(`https://www.instagram.com/p/${code}/`, {
    headers: embedHeaders(),
  });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const site = entryObject("SiteData", html);
  const polaris = entryObject("PolarisSiteData", html);
  const web = entryObject("DGWWebConfig", html);
  const push = entryObject("InstagramWebPushInfo", html);
  const lsd = entryObject("LSD", html)?.token ?? randomToken();
  const csrf = entryObject("InstagramSecurityConfig", html)?.csrf_token;
  const cookie = [
    csrf && `csrftoken=${csrf}`,
    polaris?.device_id && `ig_did=${polaris.device_id}`,
    polaris?.machine_id && `mid=${polaris.machine_id}`,
    "wd=1280x720",
    "dpr=2",
    "ig_nrcb=1",
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("; ");
  return {
    headers: {
      "X-CSRFToken": string(csrf) ?? "",
      "X-FB-LSD": string(lsd) ?? randomToken(),
      "X-Bloks-Version-Id": string(entryObject("WebBloksVersioningID", html)?.versioningID) ?? "",
      cookie,
      "x-asbd-id": "129477",
      "x-ig-app-id": string(web?.appId) ?? appId,
    },
    body: {
      __a: "1",
      __ccg: "EXCELLENT",
      __comet_req: String(queryNumber("__comet_req", html) ?? 7),
      __csr: randomToken(154),
      __d: "www",
      __dyn: randomToken(154),
      __hs: string(site?.haste_session) ?? "20126.HYP:instagram_web_pkg.2.1...0",
      __hsi: string(site?.hsi) ?? "7436540909012459023",
      __req: "b",
      __rev: string(push?.rollout_hash) ?? "1019933358",
      __s: `::${Math.random().toString(36).replace(/\d/g, "").slice(2, 8)}`,
      __spin_b: string(site?.__spin_b) ?? "trunk",
      __spin_r: string(site?.__spin_r) ?? "1019933358",
      __spin_t: String(number(site?.__spin_t) ?? Math.floor(Date.now() / 1000)),
      __user: "0",
      av: "0",
      dpr: "2",
      jazoest: String(queryNumber("jazoest", html) ?? Math.floor(Math.random() * 10000)),
      lsd: string(lsd) ?? randomToken(),
    },
  };
}

function gqlShortcodeMedia(data: Json): Json | null {
  const media = data.gql_data && object(data.gql_data)
    ? data.gql_data.shortcode_media ?? data.gql_data.xdt_shortcode_media
    : data.shortcode_media ?? data.xdt_shortcode_media;
  return object(media) ? media : null;
}

function mediaItems(media: Json, code: string, preferredWidth: number): MediaItem[] {
  const sidecar = object(media.edge_sidecar_to_children) && Array.isArray(media.edge_sidecar_to_children.edges)
    ? media.edge_sidecar_to_children.edges
    : [];
  const oldItems = sidecar.flatMap((edge, index) => {
    const node = object(edge) && object(edge.node) ? edge.node : null;
    return node ? instagramItem(node, code, index + 1, preferredWidth) : [];
  });
  if (oldItems.length > 0) {
    return oldItems;
  }
  const carousel = Array.isArray(media.carousel_media) ? media.carousel_media.filter(object) : [];
  const newItems = carousel.flatMap((item, index) => instagramItem(item, code, index + 1, preferredWidth));
  if (newItems.length > 0) {
    return newItems;
  }
  return instagramItem(media, code, null, preferredWidth);
}

function instagramItem(media: Json, code: string, index: number | null, preferredWidth: number): MediaItem[] {
  const video = selectVersion(media.video_versions, preferredWidth) ?? string(media.video_url);
  const suffix = index === null ? "" : `_${index}`;
  if (video) {
    return [{
      filename: filename(`instagram_${code}${suffix}.mp4`),
      headers: { "user-agent": browserUserAgent() },
      id: code,
      kind: "video",
      mime: "video/mp4",
      platform: "instagram",
      url: video,
    }];
  }
  const image = selectImage(media);
  return image
    ? [{
      filename: filename(`instagram_${code}${suffix}.jpg`),
      headers: { "user-agent": browserUserAgent() },
      id: code,
      kind: "image",
      mime: "image/jpeg",
      platform: "instagram",
      url: image,
    }]
    : [];
}

function selectImage(media: Json): string | null {
  const imageVersions = object(media.image_versions2) && Array.isArray(media.image_versions2.candidates)
    ? media.image_versions2.candidates.filter(object)
    : [];
  const first = imageVersions[0] ? string(imageVersions[0].url) : null;
  return first ?? string(media.display_url);
}

function selectVersion(value: unknown, preferredWidth: number): string | null {
  const versions = Array.isArray(value) ? value.filter(object) : [];
  const best = versions.reduce<Json | null>((current, candidate) => {
    const width = number(candidate.width);
    const currentWidth = current ? number(current.width) : null;
    if (width === null) {
      return current;
    }
    if (currentWidth === null) {
      return candidate;
    }
    return Math.abs(width - preferredWidth) < Math.abs(currentWidth - preferredWidth) ? candidate : current;
  }, null);
  const selected = best ?? versions[0] ?? null;
  return selected ? string(selected.url) : null;
}

function entryObject(name: string, html: string): Json | null {
  const raw = html.match(new RegExp(`\\\\["${name}",.*?,({.*?}),\\\\d+\\\\]`))?.[1];
  if (!raw) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  return object(parsed) ? parsed : null;
}

function queryNumber(name: string, html: string): number | null {
  const raw = html.match(new RegExp(`${name}=(\\d+)`))?.[1];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function randomToken(length = 8): string {
  return crypto.getRandomValues(new Uint8Array(length)).reduce((value, byte) => value + (byte % 36).toString(36), "");
}
