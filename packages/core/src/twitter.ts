import {
  asUrl,
  bool,
  count,
  filename,
  isoFromDateString,
  number,
  object,
  string,
  type PostMetadata,
  type TwitterExtra,
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
  const items = twitterTweets(tweet, id).flatMap(({ id: postId, tweet: post }) => {
    const media = Array.isArray(post.mediaDetails) ? post.mediaDetails.filter(object) : [];
    return media.flatMap((entry, index) => twitterItem(entry, postId, index + 1));
  });
  if (items.length === 0) {
    throw new Error("Twitter media not found");
  }
  return { archiveFilename: filename(`twitter_${id}.zip`), id, items, metadata: twitterMetadata(tweet), platform: "twitter" };
}

export function twitterMetadata(tweet: Json): PostMetadata & { extra?: TwitterExtra } {
  const user = object(tweet.user) ? tweet.user : null;
  const extra: TwitterExtra = {};
  const lang = string(tweet.lang);
  if (lang) {
    extra.lang = lang;
  }
  const quotedTweet = object(tweet.quoted_tweet) ? tweet.quoted_tweet : null;
  const quotedId = quotedTweet ? string(quotedTweet.id_str) : null;
  if (quotedTweet && quotedId) {
    extra.quotedTweet = { id: quotedId, metadata: twitterMetadata(quotedTweet) };
  }
  return {
    text: (string(tweet.text) ?? string(tweet.full_text)) ?? undefined,
    author: user
      ? {
          handle: string(user.screen_name) ?? undefined,
          name: string(user.name) ?? undefined,
          verified: bool(user.verified) ?? bool(user.is_blue_verified),
        }
      : undefined,
    createdAt: isoFromDateString(tweet.created_at),
    likeCount: count(tweet.favorite_count),
    commentCount: count(tweet.conversation_count),
    shareCount: count(tweet.retweet_count),
    viewCount: count(tweet.view_count),
    nsfw: bool(tweet.possibly_sensitive),
    extra,
  };
}

function twitterTweets(tweet: Json, rootId: string): Array<{ id: string; tweet: Json }> {
  const tweets: Array<{ id: string; tweet: Json }> = [];
  const seen = new Set<string>();
  let current: Json | null = tweet;
  let fallbackId: string | null = rootId;
  while (current) {
    const id = string(current.id_str) ?? fallbackId;
    if (!id || seen.has(id)) {
      break;
    }
    tweets.push({ id, tweet: current });
    seen.add(id);
    current = object(current.quoted_tweet) ? current.quoted_tweet : null;
    fallbackId = null;
  }
  return tweets;
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

export function tweetId(input: string): string | null {
  return asUrl(input).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? null;
}
