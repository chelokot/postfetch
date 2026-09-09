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
  type PostComment,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";

type TwitterCandidate = {
  bitrate: number;
  item: MediaItem;
};

export async function resolveTwitter(input: ResolveContext): Promise<PostfetchResult> {
  const id = tweetId(input.url);
  if (!id) {
    throw new Error("Tweet id not found");
  }
  const tweet = await syndication(input.net, id);
  if (string(tweet.__typename) === "TweetTombstone") {
    throw new Error("Tweet is unavailable or age-restricted");
  }
  await expandTwitterText(input.net, tweet, id);
  const groups = twitterTweets(tweet, id).flatMap(({ id: postId, tweet: post }) => {
    const media = Array.isArray(post.mediaDetails) ? post.mediaDetails.filter(object) : [];
    return media.flatMap((entry, index) => {
      const candidates = twitterCandidates(entry, postId, index + 1);
      return candidates.length > 0 ? [candidates] : [];
    });
  });
  const items = input.tryMaxBytes === undefined ? groups.map((group) => group[0].item) : await sizeLimitedItems(input, groups);
  // A text-only tweet is a valid result with metadata and no media. Syndication
  // has already failed or returned a tombstone when the tweet is unavailable,
  // so an empty item list here does not mean the lookup failed.
  return { archiveFilename: filename(`twitter_${id}.zip`), comments: await twitterComments(input, id), id, items, metadata: twitterMetadata(tweet), platform: "twitter" };
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
  const parent = object(tweet.parent) ? tweet.parent : null;
  const parentId = parent ? string(parent.id_str) : null;
  if (parent && parentId) {
    extra.parentTweet = { id: parentId, metadata: twitterMetadata(parent) };
  }
  return {
    text: twitterText(tweet) ?? undefined,
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

function noteText(tweet: Json): string | null {
  const note = object(tweet.note_tweet) ? tweet.note_tweet : null;
  const results = note && object(note.note_tweet_results) ? note.note_tweet_results : null;
  const result = results && object(results.result) ? results.result : null;
  return (result ? string(result.text) : null) ?? (note ? string(note.text) : null);
}

function twitterText(tweet: Json): string | null {
  return noteText(tweet) ?? string(tweet.full_text) ?? string(tweet.text);
}

function needsFullText(tweet: Json): boolean {
  if (noteText(tweet) || string(tweet.full_text)) {
    return false;
  }
  // Embedded quotes can omit note_tweet entirely. Near-limit text is only a
  // hint: ordinary long tweets may also incur a lookup, but are never shortened.
  return object(tweet.note_tweet) || bool(tweet.truncated) === true || (string(tweet.text)?.length ?? 0) >= 270;
}

async function expandTwitterText(net: Net, tweet: Json, rootId: string): Promise<void> {
  const posts = new Map(twitterTweets(tweet, rootId, true).map(({ id, tweet: post }) => [id, post]));
  for (const [id, post] of posts) {
    if (!needsFullText(post)) {
      continue;
    }
    try {
      // FxTwitter's public v1 API includes full note text and embedded quotes.
      // Keep media and other metadata from X, and don't retry an optional lookup.
      const response = await net(`https://api.fxtwitter.com/status/${id}`, {
        headers: { accept: "application/json", "user-agent": browserUserAgent() },
      }, 1);
      if (!response.ok) {
        continue;
      }
      const payload: unknown = await response.json();
      if (!object(payload) || payload.code !== 200 || !object(payload.tweet) || string(payload.tweet.id) !== id) {
        continue;
      }
      let current: Json | null = payload.tweet;
      const seen = new Set<string>();
      while (current) {
        const currentId = string(current.id);
        if (!currentId || seen.has(currentId)) {
          break;
        }
        seen.add(currentId);
        const target = posts.get(currentId);
        const raw = object(current.raw_text) ? string(current.raw_text.text) : null;
        const text = raw ?? string(current.text);
        if (target && needsFullText(target) && text && text.length > (twitterText(target)?.length ?? 0)) {
          target.full_text = text;
        }
        current = object(current.quote) ? current.quote : null;
      }
    } catch {
      // A text enrichment outage must not discard a valid syndication result.
    }
  }
}

function twitterTweets(tweet: Json, rootId: string, includeParents = false): Array<{ id: string; tweet: Json }> {
  const tweets: Array<{ id: string; tweet: Json }> = [];
  const seen = new Set<string>();
  const visit = (current: Json, fallbackId?: string): void => {
    const id = string(current.id_str) ?? fallbackId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    tweets.push({ id, tweet: current });
    if (object(current.quoted_tweet)) visit(current.quoted_tweet);
    if (includeParents && object(current.parent)) visit(current.parent);
  };
  visit(tweet, rootId);
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

function twitterCandidates(entry: Json, id: string, index: number): TwitterCandidate[] {
  const headers = { "user-agent": browserUserAgent() };
  const type = string(entry.type);
  if (type === "video" || type === "animated_gif") {
    return videoVariants(entry).map(({ bitrate, url }) => ({
      bitrate,
      item: { filename: filename(`twitter_${id}_${index}.mp4`), headers, id, kind: "video", mime: "video/mp4", platform: "twitter", url },
    }));
  }
  const photo = string(entry.media_url_https);
  return photo
    ? [{ bitrate: 0, item: { filename: filename(`twitter_${id}_${index}.jpg`), headers, id, kind: "image", mime: "image/jpeg", platform: "twitter", url: `${photo}?name=orig` } }]
    : [];
}

function videoVariants(entry: Json): Array<{ bitrate: number; url: string }> {
  const info = object(entry.video_info) ? entry.video_info : null;
  const variants = info && Array.isArray(info.variants) ? info.variants.filter(object) : [];
  const seen = new Set<string>();
  return variants
    .flatMap((variant) => {
      const url = string(variant.url);
      if (string(variant.content_type) !== "video/mp4" || !url || seen.has(url)) {
        return [];
      }
      seen.add(url);
      return [{ bitrate: number(variant.bitrate) ?? 0, url }];
    })
    .sort((left, right) => right.bitrate - left.bitrate);
}

async function sizeLimitedItems(input: ResolveContext, groups: TwitterCandidate[][]): Promise<MediaItem[]> {
  if (groups.length === 0 || input.tryMaxBytes === undefined) {
    return groups.map((group) => group[0].item);
  }
  const sizes = new Map<string, Promise<number | null>>();
  const size = (candidate: TwitterCandidate): Promise<number | null> => {
    const existing = sizes.get(candidate.item.url);
    if (existing) {
      return existing;
    }
    const pending = contentLength(input.net, candidate.item);
    sizes.set(candidate.item.url, pending);
    return pending;
  };

  const highest = groups.map((group) => group[0]);
  const highestSizes = await Promise.all(highest.map(size));
  const highestTotal = knownTotal(highestSizes);
  if (highestTotal !== null && highestTotal <= input.tryMaxBytes) {
    return highest.map(({ item }) => item);
  }

  const sized = await Promise.all(
    groups.map(async (group) =>
      Promise.all(group.map(async (candidate) => ({ ...candidate, bytes: await size(candidate) }))),
    ),
  );
  const fitting = bestFitting(sized, input.tryMaxBytes);
  return (fitting ?? groups.map((group) => group.at(-1) as TwitterCandidate)).map(({ item }) => item);
}

function knownTotal(sizes: Array<number | null>): number | null {
  return sizes.some((size) => size === null) ? null : sizes.reduce<number>((total, size) => total + (size ?? 0), 0);
}

function bestFitting(
  groups: Array<Array<TwitterCandidate & { bytes: number | null }>>,
  maxBytes: number,
): TwitterCandidate[] | null {
  let selections: Array<{ bytes: number; candidates: TwitterCandidate[]; quality: number }> = [
    { bytes: 0, candidates: [], quality: 0 },
  ];
  for (const group of groups) {
    selections = selections.flatMap((selection) =>
      group.flatMap((candidate) => {
        if (candidate.bytes === null || selection.bytes + candidate.bytes > maxBytes) {
          return [];
        }
        return [{
          bytes: selection.bytes + candidate.bytes,
          candidates: [...selection.candidates, candidate],
          quality: selection.quality + candidate.bitrate,
        }];
      }),
    );
    if (selections.length === 0) {
      return null;
    }
  }
  const best = selections.reduce((current, selection) => (selection.quality > current.quality ? selection : current));
  return best.candidates;
}

async function contentLength(net: Net, item: MediaItem): Promise<number | null> {
  try {
    const response = await net(item.url, { headers: item.headers, method: "HEAD" }, 1);
    const raw = response.ok ? response.headers.get("content-length") : null;
    if (!raw || !/^\d+$/.test(raw)) {
      return null;
    }
    const bytes = Number(raw);
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

export function tweetId(input: string): string | null {
  return asUrl(input).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? null;
}

async function twitterComments(input: ResolveContext, id: string): Promise<PostComment[]> {
  const limit = input.comments;
  if (!limit || !Number.isSafeInteger(limit) || limit < 0) return [];
  try {
    const comments: PostComment[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const url = new URL(`https://api.fxtwitter.com/2/conversation/${id}`);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await input.net(url.href, { headers: { accept: "application/json", "user-agent": browserUserAgent() } }, 1);
      if (!response.ok) throw new Error("Comment lookup failed");
      const payload: unknown = await response.json();
      if (!object(payload) || payload.code !== 200 || !Array.isArray(payload.replies)) throw new Error("Invalid comments");
      const previousCount = comments.length;
      for (const reply of payload.replies) {
        if (!object(reply)) continue;
        const replyId = string(reply.id);
        const parent = object(reply.replying_to) ? string(reply.replying_to.status) : null;
        if (!replyId || parent !== id || seen.has(replyId)) continue;
        seen.add(replyId);
        comments.push(twitterComment(reply, replyId));
        if (comments.length >= limit) return comments;
      }
      cursor = object(payload.cursor) ? string(payload.cursor.bottom) : null;
      if (!cursor || cursors.has(cursor) || comments.length === previousCount) break;
      cursors.add(cursor);
    } while (comments.length < limit);
    return comments;
  } catch {
    return [];
  }
}

function twitterComment(reply: Json, id: string): PostComment {
  const author = object(reply.author) ? reply.author : {};
  const verification = object(author.verification) ? author.verification : {};
  const media = object(reply.media) && Array.isArray(reply.media.all) ? reply.media.all.filter(object) : [];
  const items: MediaItem[] = media.flatMap((entry, index) => {
    const url = string(entry.url);
    const photo = entry.type === "photo";
    if (!url || (!photo && entry.type !== "video" && entry.type !== "gif" && entry.type !== "animated_gif")) return [];
    return [{
      id,
      platform: "twitter",
      filename: filename(`twitter_${id}_${index + 1}.${photo ? "jpg" : "mp4"}`),
      kind: photo ? "image" : "video",
      mime: photo ? "image/jpeg" : "video/mp4",
      url,
      headers: { "user-agent": browserUserAgent() },
    }];
  });
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    items,
    metadata: {
      text: string(reply.text) ?? undefined,
      author: {
        handle: string(author.screen_name) ?? undefined,
        name: string(author.name) ?? undefined,
        verified: bool(verification.verified),
      },
      createdAt: isoFromDateString(reply.created_at),
      likeCount: count(reply.likes),
      commentCount: count(reply.replies),
      shareCount: count(reply.reposts),
      viewCount: count(reply.views),
      nsfw: bool(reply.possibly_sensitive),
    },
  };
}
