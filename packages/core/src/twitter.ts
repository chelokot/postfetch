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

export async function resolveTwitter(input: ResolveContext): Promise<PostfetchResult> {
  const id = tweetId(input.url);
  if (!id) {
    throw new Error("Tweet id not found");
  }
  const tweet = await syndication(input.net, id);
  if (string(tweet.__typename) === "TweetTombstone") {
    throw new Error("Tweet is unavailable or age-restricted");
  }
  const media = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails.filter(object) : [];
  const items = media.flatMap((entry, index) => twitterItem(entry, id, index + 1));
  if (items.length === 0) {
    throw new Error("Twitter media not found");
  }
  return { archiveFilename: filename(`twitter_${id}.zip`), id, items, platform: "twitter" };
}

// The public syndication endpoint returns tweet media (video variants + photos)
// without a guest token or bearer; the token is a non-validated cache key.
async function syndication(net: Net, id: string): Promise<Json> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`;
  const response = await net(url, { headers: { accept: "application/json", "user-agent": browserUserAgent() } });
  if (!response.ok) {
    throw new Error(`Twitter syndication failed: ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!object(payload)) {
    throw new Error("Twitter response invalid");
  }
  return payload;
}

function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function twitterItem(entry: Json, id: string, index: number): MediaItem[] {
  const headers = { "user-agent": browserUserAgent() };
  const type = string(entry.type);
  if (type === "video" || type === "animated_gif") {
    const url = bestVariant(entry);
    return url
      ? [{ filename: filename(`twitter_${id}_${index}.mp4`), headers, id, kind: "video", mime: "video/mp4", platform: "twitter", url }]
      : [];
  }
  const photo = string(entry.media_url_https);
  return photo
    ? [{ filename: filename(`twitter_${id}_${index}.jpg`), headers, id, kind: "image", mime: "image/jpeg", platform: "twitter", url: `${photo}?name=orig` }]
    : [];
}

function bestVariant(entry: Json): string | null {
  const info = object(entry.video_info) ? entry.video_info : null;
  const variants = info && Array.isArray(info.variants) ? info.variants.filter(object) : [];
  const best = variants
    .filter((variant) => string(variant.content_type) === "video/mp4")
    .reduce<Json | null>((current, variant) => {
      const bitrate = number(variant.bitrate) ?? 0;
      const currentBitrate = current ? number(current.bitrate) ?? 0 : -1;
      return bitrate > currentBitrate ? variant : current;
    }, null);
  return best ? string(best.url) : null;
}

function tweetId(input: string): string | null {
  return asUrl(input).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? null;
}
