import {
  asUrl,
  bool,
  count,
  filename,
  isoFromEpochSeconds,
  number,
  object,
  string,
  type PostMetadata,
  type PostComment,
  type RedditExtra,
  type ResolveContext,
  type Json,
  type Net,
  type PostfetchResult,
  type MediaItem,
} from "./internal";
import { browserUserAgent } from "./fingerprint";
import { fetchWebPost, fetchEmbeddedPost, fetchRssPost, readWebPage, type RedditPage } from "./reddit-web";
import { ReplyTree } from "./reply-tree";

// The installed-app token can still be issued while both OAuth post routes
// reject it with Reddit's network-security page. Keep the public page as a
// fallback rather than treating a successful token request as API availability.
const installedClientId = "ohXpoqrZYub1kg";

export async function resolveReddit(input: ResolveContext): Promise<PostfetchResult> {
  const { id, url, page } = await postId(input.net, input.url);
  const token = await appToken(input.net);
  const post = await fetchPost(input.net, token, id, url, page);
  // A text post is a valid result with metadata and no media — fetchPost has
  // already thrown if the post itself is missing, so empty items here mean a
  // self/text post, not a failure.
  const items = await mediaItems(input, post, id);
  return { archiveFilename: filename(`reddit_${id}.zip`), comments: await redditComments(input, token, id, redditAuthor(post.author)), id, items, metadata: redditMetadata(post), platform: "reddit" };
}

export function redditMetadata(post: Json): PostMetadata & { extra?: RedditExtra } {
  const author = string(post.author);
  return {
    title: string(post.title) ?? undefined,
    text: string(post.selftext) ?? undefined,
    author: author ? { handle: author } : undefined,
    createdAt: isoFromEpochSeconds(post.created_utc),
    likeCount: count(post.ups),
    commentCount: count(post.num_comments),
    nsfw: bool(post.over_18),
    extra: {
      subreddit: string(post.subreddit) ?? undefined,
      score: number(post.score) ?? undefined,
      upvoteRatio: number(post.upvote_ratio) ?? undefined,
      permalink: string(post.permalink) ?? undefined,
    },
  };
}

// Share links have no post id. Retain their canonical page and client identity
// so a blocked API lookup can reuse the response instead of fetching it again.
async function postId(net: Net, input: string): Promise<{ id: string; url: string; page?: RedditPage }> {
  const direct = parseId(input);
  if (direct) {
    return { id: direct, url: input };
  }
  const userAgent = browserUserAgent();
  const page = await readWebPage(await net(input, { headers: { "user-agent": userAgent } }, 1), userAgent);
  const resolved = parseId(page.url);
  if (!resolved) {
    throw new Error("Reddit post id not found");
  }
  return { id: resolved, url: page.url, page };
}

function parseId(input: string): string | null {
  const url = asUrl(input);
  if (url.hostname === "redd.it") {
    const slug = url.pathname.split("/").filter(Boolean)[0];
    return slug && /^[a-z0-9]+$/i.test(slug) ? slug : null;
  }
  return url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] ?? null;
}

async function appToken(net: Net): Promise<string> {
  const response = await net("https://www.reddit.com/api/v1/access_token", {
    body: "grant_type=https://oauth.reddit.com/grants/installed_client&device_id=DO_NOT_TRACK_THIS_DEVICE",
    headers: {
      authorization: `Basic ${btoa(`${installedClientId}:`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": browserUserAgent(),
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Reddit auth failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const token = object(payload) ? string(payload.access_token) : null;
  if (!token) {
    throw new Error("Reddit token not found");
  }
  return token;
}

async function fetchPost(net: Net, token: string, id: string, url: string, page?: RedditPage): Promise<Json> {
  const headers = { authorization: `Bearer ${token}`, "user-agent": browserUserAgent() };
  let response = await net(`https://oauth.reddit.com/comments/${id}?raw_json=1&limit=1`, { headers });
  // Reddit can block the comments route while still allowing direct post
  // listings with the same token. This route returns the post, not its replies.
  if (response.status === 403) {
    await response.body?.cancel();
    response = await net(`https://oauth.reddit.com/by_id/t3_${id}?raw_json=1`, { headers });
  }
  if (!response.ok) {
    if (response.status === 403) {
      await response.body?.cancel();
      // Public pages can remain available when both OAuth routes are
      // blocked. Keep the original failure if the page cannot supply the post.
      const post = await fetchWebPost(net, id, url, page).catch(() => null);
      if (post) return post;
      const embedded = await fetchEmbeddedPost(net, id).catch(() => null);
      if (embedded) return embedded;
      const rss = await fetchRssPost(net, id).catch(() => null);
      if (rss) return rss;
    }
    throw new Error(`Reddit post failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const listing = Array.isArray(payload) ? payload[0] : payload;
  const children = object(listing) && object(listing.data) && Array.isArray(listing.data.children) ? listing.data.children : [];
  const first = children[0];
  const post = object(first) && object(first.data) ? first.data : null;
  if (!post) {
    throw new Error("Reddit post not found");
  }
  return post;
}

async function mediaItems(input: ResolveContext, post: Json, id: string): Promise<MediaItem[]> {
  const own = await extract(input, post, id);
  if (own.length > 0) {
    return own;
  }
  const parents = Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list.filter(object) : [];
  const parent = parents[0];
  const inherited = parent ? await extract(input, parent, id) : [];
  if (inherited.length > 0) {
    return inherited;
  }
  return linkPreviewItems(post, id).concat(parent ? linkPreviewItems(parent, id) : []).slice(0, 1);
}

async function extract(input: ResolveContext, post: Json, id: string): Promise<MediaItem[]> {
  const gallery = await galleryMedia(input, post, id);
  if (gallery.length > 0) {
    return gallery;
  }
  const video = await videoItems(input, post, id);
  if (video.length > 0) {
    return video;
  }
  return imageItems(post, id);
}

async function galleryMedia(input: ResolveContext, post: Json, id: string): Promise<MediaItem[]> {
  const metadata = object(post.media_metadata) ? post.media_metadata : {};
  if (!Object.values(metadata).some((meta) => object(meta) && meta.e === "RedditVideo")) return galleryItems(post, id);
  const data = object(post.gallery_data) ? post.gallery_data : null;
  const order = data && Array.isArray(data.items) ? data.items.filter(object) : [];
  const items: MediaItem[] = [];
  for (const [index, entry] of order.entries()) {
    const key = string(entry.media_id);
    const meta = key && object(metadata[key]) ? metadata[key] : null;
    if (meta?.e === "RedditVideo") {
      const videos = await videoItems(input, { secure_media: { reddit_video: { dash_url: meta.dashUrl } } }, id);
      if (!videos.length) throw new Error("Reddit gallery video unavailable");
      items.push(...videos.map((video) => ({ ...video, filename: filename(`reddit_${id}_${index + 1}.mp4`) })));
    } else {
      // Retain the original position in filenames when videos split the images.
      items.push(...galleryItems({ ...post, gallery_data: { items: [entry] } }, id, index + 1));
    }
  }
  return items;
}

function galleryItems(post: Json, id: string, startIndex = 1): MediaItem[] {
  const data = object(post.gallery_data) ? post.gallery_data : null;
  const order = data && Array.isArray(data.items) ? data.items.filter(object) : [];
  const metadata = object(post.media_metadata) ? post.media_metadata : {};
  return order.flatMap((entry, index) => {
    const mediaId = string(entry.media_id);
    const meta = mediaId && object(metadata[mediaId]) ? metadata[mediaId] : null;
    const best = meta && object(meta.s) ? meta.s : null;
    if (!best) {
      return [];
    }
    const video = string(best.mp4);
    if (video) {
      return [mediaItem(id, index + startIndex, "video", "video/mp4", video)];
    }
    const image = string(best.u) ?? string(best.gif);
    return image ? [mediaItem(id, index + startIndex, "image", mimeOf(string(meta?.m), image), image)] : [];
  });
}

type Rendition = { width: number | null; bandwidth: number; base: string };

async function videoItems(input: ResolveContext, post: Json, id: string): Promise<MediaItem[]> {
  const media = redditVideo(post);
  const fallback = media ? string(media.fallback_url) : null;
  if (!media) {
    return [];
  }
  const dashUrl = string(media.dash_url);
  // Public pages expose the player and manifest rather than a fallback stream
  // or has_audio flag. Inspect the manifest so silent clips remain silent and
  // clips with audio retain their separate track through the normal remuxer.
  if (!fallback && dashUrl) {
    const streams = await dashStreams(input.net, dashUrl, input.preferredWidth, true);
    if (!streams) throw new Error("Reddit DASH manifest unavailable for muxing");
    return [streams.audio
      ? muxedVideoItem(id, streams.video, streams.audio)
      : mediaItem(id, null, "video", "video/mp4", streams.video)];
  }
  if (!fallback) return [];
  if (media.has_audio !== true) {
    return [mediaItem(id, null, "video", "video/mp4", fallback)];
  }
  // The fallback stream is video-only; reddit keeps audio in a separate DASH
  // rendition, so a complete file is the video and audio streams merged.
  const streams = dashUrl ? await dashStreams(input.net, dashUrl, input.preferredWidth) : null;
  if (!streams?.audio) {
    throw new Error("Reddit DASH manifest unavailable for muxing");
  }
  return [muxedVideoItem(id, streams.video, streams.audio)];
}

async function dashStreams(net: Net, dashUrl: string, preferredWidth: number, allowSilent = false): Promise<{ video: string; audio?: string } | null> {
  const response = await net(dashUrl, { headers: { "user-agent": browserUserAgent() } });
  if (!response.ok) {
    return null;
  }
  const manifest = await response.text();
  const base = dashUrl.slice(0, dashUrl.lastIndexOf("/") + 1);
  const query = dashUrl.includes("?") ? dashUrl.slice(dashUrl.indexOf("?")) : "";
  const video = videoRendition(manifest, preferredWidth);
  const audio = audioRendition(manifest);
  if (!video || (!audio && !allowSilent)) {
    return null;
  }
  return { video: `${base}${video}${query}`, ...(audio ? { audio: `${base}${audio}${query}` } : {}) };
}

function videoRendition(manifest: string, preferredWidth: number): string | null {
  const renditions = renditionsOf(manifest, false);
  const sized = renditions.filter((rendition) => rendition.width !== null);
  const pool = sized.length > 0 ? sized : renditions;
  const best = pool.reduce<Rendition | null>((current, rendition) => {
    if (!current) {
      return rendition;
    }
    if (rendition.width !== null && current.width !== null) {
      return Math.abs(rendition.width - preferredWidth) < Math.abs(current.width - preferredWidth) ? rendition : current;
    }
    return rendition.bandwidth > current.bandwidth ? rendition : current;
  }, null);
  return best ? best.base : null;
}

function audioRendition(manifest: string): string | null {
  const best = renditionsOf(manifest, true).reduce<Rendition | null>(
    (current, rendition) => (!current || rendition.bandwidth > current.bandwidth ? rendition : current),
    null,
  );
  return best ? best.base : null;
}

function renditionsOf(manifest: string, audio: boolean): Rendition[] {
  return manifest
    .split("<AdaptationSet")
    .slice(1)
    .filter((chunk) => isAudioSet(chunk) === audio)
    .flatMap((chunk) =>
      [...chunk.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)].flatMap((match) => {
        const segment = match[2].match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
        if (!segment) {
          return [];
        }
        const width = match[1].match(/(?:^|[^a-zA-Z])width="(\d+)"/)?.[1];
        return [{ width: width ? Number(width) : null, bandwidth: Number(match[1].match(/bandwidth="(\d+)"/)?.[1] ?? 0), base: segment }];
      }),
    );
}

function isAudioSet(chunk: string): boolean {
  const head = chunk.slice(0, chunk.indexOf(">"));
  return /contentType="audio"/.test(head) || /mimeType="audio/.test(head);
}

function muxedVideoItem(id: string, videoUrl: string, audioUrl: string): MediaItem {
  return {
    audio: { headers: { "user-agent": browserUserAgent() }, url: audioUrl },
    filename: filename(`reddit_${id}.mp4`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind: "video",
    mime: "video/mp4",
    platform: "reddit",
    url: videoUrl,
  };
}

function redditVideo(post: Json): Json | null {
  const secure = object(post.secure_media) ? post.secure_media : null;
  const media = object(post.media) ? post.media : null;
  const fromSecure = secure && object(secure.reddit_video) ? secure.reddit_video : null;
  const fromMedia = media && object(media.reddit_video) ? media.reddit_video : null;
  return fromSecure ?? fromMedia;
}

function imageItems(post: Json, id: string): MediaItem[] {
  const url = string(post.url_overridden_by_dest) ?? string(post.url);
  if (!url) {
    return [];
  }
  const path = asUrl(url).pathname;
  const isImage = string(post.post_hint) === "image" || asUrl(url).hostname === "i.redd.it" || /\.(jpe?g|png|webp|gif)$/i.test(path);
  return isImage ? [mediaItem(id, null, "image", mimeOf(null, url), url)] : [];
}

function linkPreviewItems(post: Json, id: string): MediaItem[] {
  // Reddit also supplies preview images for photos/videos and self posts. Only
  // external link cards belong here; native attachments take precedence above.
  const destination = string(post.url_overridden_by_dest) ?? string(post.url);
  if (post.is_self === true || !destination) return [];
  try {
    const url = new URL(destination);
    if (!/^https?:$/.test(url.protocol) || /(^|\.)(reddit\.com|redd\.it)$/.test(url.hostname)) return [];
  } catch {
    return [];
  }
  const preview = object(post.preview) ? post.preview : null;
  const images = preview && Array.isArray(preview.images) ? preview.images.filter(object) : [];
  const candidates = images.flatMap((image) => {
    const source = object(image.source) ? [image.source] : [];
    const resolutions = Array.isArray(image.resolutions) ? image.resolutions.filter(object) : [];
    return [...source, ...resolutions].flatMap((rendition, index) => {
      const rawUrl = string(rendition.url);
      if (!rawUrl) return [];
      try {
        const url = new URL(rawUrl.replace(/&amp;/g, "&"));
        if (!/^https?:$/.test(url.protocol)) return [];
        return [{
          url: url.href,
          original: source.length > 0 && index === 0 ? 1 : 0,
          area: Math.max(0, number(rendition.width) ?? 0) * Math.max(0, number(rendition.height) ?? 0),
        }];
      } catch {
        return [];
      }
    });
  }).sort((a, b) => b.original - a.original || b.area - a.area);
  const best = candidates[0];
  if (!best) return [];
  const mime = mimeOf(null, best.url);
  return [{
    ...mediaItem(id, null, "image", mime, best.url),
    filename: filename(`reddit_${id}_preview.${extensionOf(mime)}`),
    role: "linkPreview",
  }];
}

function mediaItem(id: string, index: number | null, kind: MediaItem["kind"], mime: string, url: string): MediaItem {
  const suffix = index === null ? "" : `_${index}`;
  return {
    filename: filename(`reddit_${id}${suffix}.${extensionOf(mime)}`),
    headers: { "user-agent": browserUserAgent() },
    id,
    kind,
    mime,
    platform: "reddit",
    url,
  };
}

function mimeOf(declared: string | null, url: string): string {
  if (declared && declared.includes("/")) {
    return declared.replace("image/jpg", "image/jpeg");
  }
  const extension = asUrl(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  if (extension === "gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

function extensionOf(mime: string): string {
  if (mime === "video/mp4") {
    return "mp4";
  }
  if (mime === "image/png") {
    return "png";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  if (mime === "image/gif") {
    return "gif";
  }
  return "jpg";
}

function redditAuthor(value: unknown): string | undefined {
  const name = string(value)?.toLowerCase();
  return name === "[deleted]" ? undefined : name;
}

function commentListing(payload: unknown): unknown[] {
  const listing = Array.isArray(payload) ? payload[1] : null;
  if (!object(listing) || !object(listing.data) || !Array.isArray(listing.data.children)) throw new Error("Invalid Reddit comments");
  return listing.data.children;
}

async function redditComments(input: ResolveContext, token: string, id: string, author: string | undefined): Promise<PostComment[]> {
  const limit = input.comments ?? 0;
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const rootId = `t3_${id}`;
  const headers = { authorization: `Bearer ${token}`, "user-agent": browserUserAgent() };
  const tree = new ReplyTree<{ data: Json; body: string }>(rootId);
  const queued = new Set<string>();
  const pending = new Map<string, string[]>();
  const continuations = new Set<string>();

  function collect(things: unknown[]) {
    const entries = [...things];
    for (const thing of entries) {
      if (!object(thing) || !object(thing.data)) continue;
      const data = thing.data;
      const parentId = string(data.parent_id);
      if (!parentId || (parentId !== rootId && (!author || !/^t1_[a-z0-9]+$/i.test(parentId)))) continue;
      if (thing.kind === "more" && Array.isArray(data.children)) {
        if (parentId !== rootId && data.children.length === 0 && (data.count === 0 || data.id === "_")) {
          continuations.add(parentId);
        }
        const children = pending.get(parentId) ?? [];
        for (const child of data.children) {
          if (typeof child !== "string" || !/^[a-z0-9]+$/i.test(child) || queued.has(child)) continue;
          queued.add(child);
          children.push(child);
        }
        pending.set(parentId, children);
      } else if (thing.kind === "t1") {
        const commentId = string(data.id);
        const body = string(data.body);
        if (!commentId || !body || body === "[deleted]" || body === "[removed]") continue;
        const byAuthor = !!author && redditAuthor(data.author) === author;
        tree.add({ id: `t1_${commentId}`, parentId, byAuthor, value: { data, body } });
        if (byAuthor && object(data.replies) && object(data.replies.data) && Array.isArray(data.replies.data.children)) {
          for (const child of data.replies.data.children) entries.push(child);
        }
      }
    }
  }

  try {
    const query = `raw_json=1&limit=${author ? 100 : Math.min(limit, 100)}${author ? "" : "&depth=1"}&sort=top`;
    const url = `https://oauth.reddit.com/comments/${id}`;
    const response = await input.net(`${url}?${query}`, { headers }, 1);
    if (response.status === 403) {
      await response.body?.cancel();
      return await graphqlComments(input.net, headers, id, limit, author);
    }
    if (!response.ok) throw new Error("Reddit comments failed");
    collect(commentListing(await response.json()));

    for (const parentId of tree.authorParents()) {
      if (continuations.has(parentId)) {
        const thread = await input.net(`${url}/_/${parentId.slice(3)}?${query}&context=0`, { headers }, 1);
        if (thread.status === 403) {
          await thread.body?.cancel();
          return await graphqlComments(input.net, headers, id, limit, author);
        }
        if (!thread.ok) throw new Error("Reddit comment thread failed");
        collect(commentListing(await thread.json()));
      }

      const children = pending.get(parentId) ?? [];
      while (children.length > 0 && (author || tree.children().length < limit)) {
        const batch = children.splice(0, author ? 100 : Math.min(100, limit - tree.children().length));
        const moreUrl = new URL("https://oauth.reddit.com/api/morechildren");
        moreUrl.search = new URLSearchParams({
          api_type: "json", raw_json: "1", link_id: rootId, children: batch.join(","), sort: "top", limit_children: "true",
          ...(!author && { depth: "1" }),
        }).toString();
        const more = await input.net(moreUrl.href, { headers }, 1);
        if (more.status === 403) {
          await more.body?.cancel();
          return await graphqlComments(input.net, headers, id, limit, author);
        }
        if (!more.ok) throw new Error("Reddit more comments failed");
        const result: unknown = await more.json();
        const json = object(result) && object(result.json) ? result.json : null;
        const data = json && object(json.data) ? json.data : null;
        if (!data || !Array.isArray(data.things) || (Array.isArray(json?.errors) && json.errors.length > 0)) throw new Error("Invalid additional Reddit comments");
        collect(data.things);
      }
    }
  } catch {
    if (!author || (tree.children().length < limit && !tree.children().some((reply) => reply.byAuthor))) return [];
  }
  return tree.select(limit).map(({ id: fullname, value: { data, body } }) => redditComment(data, fullname.slice(3), id, body));
}

// Reddit blocks anonymous OAuth comment routes while its mobile GraphQL API
// still accepts the same token. This is the app's registered PostComments query;
// gql-fed rejects arbitrary query text. Keep the JSON API as the first choice.
const postCommentsHash = "314f29c2494fd78c7844ef2c6b09acb4bef5b37ab50b4ddc01691d6d5c8433f8";

async function graphqlComments(net: Net, headers: Record<string, string>, id: string, limit: number, author: string | undefined): Promise<PostComment[]> {
  const rootId = `t3_${id}`;
  const maxDepth = author ? 8 : 1;
  const tree = new ReplyTree<{ node: Json; content: Json; body: string }>(rootId);
  const pending = new Map<string, Array<{ after?: string; focus?: string }>>([[rootId, [{}]]]);
  const seenCursors = new Set<string>();
  const focused = new Set<string>();

  for (const parent of tree.authorParents()) {
    const pages = pending.get(parent) ?? [];
    while (pages.length > 0 && (author || tree.children().length < limit)) {
      const { after, focus } = pages.shift()!;
      try {
        const response = await net("https://gql-fed.reddit.com/", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            operationName: "PostComments",
            variables: {
              id: rootId, sortType: "TOP", count: author ? 200 : Math.min(200, limit - tree.children().length), maxDepth,
              includeConsistencyToken: false, includePremiumAvatarTreatment: false,
              ...(after && { after }),
              ...(focus && { focusedCommentContext: { commentId: focus, isFocusedThreadOnly: true } }),
            },
            extensions: { persistedQuery: { version: 1, sha256Hash: postCommentsHash } },
          }),
        }, 1);
        if (!response.ok) throw new Error(`Reddit GraphQL comments failed: ${response.status}`);
        const payload: unknown = await response.json();
        const data = object(payload) && object(payload.data) ? payload.data : null;
        const post = data && object(data.postInfoById) ? data.postInfoById : null;
        const forest = post && object(post.commentForest) ? post.commentForest : null;
        if (!forest || !Array.isArray(forest.trees)) throw new Error("Invalid Reddit GraphQL comments");

        for (const entry of forest.trees) {
          if (!object(entry)) continue;
          const parentId = entry.depth === 0 && entry.parentId == null ? rootId : string(entry.parentId);
          const direct = parentId === rootId && entry.depth === 0;
          if (!parentId || (!direct && (!author || !/^t1_[a-z0-9]+$/i.test(parentId)))) continue;
          if (object(entry.more)) {
            const cursor = string(entry.more.cursor);
            const branch = direct && focus ? focus : parentId;
            const next = pending.get(branch) ?? [];
            // At the depth boundary, Reddit continues from a focused comment.
            if (!direct && (entry.more.isTooDeepForCount === true || (number(entry.depth) ?? 0) >= maxDepth)) {
              if (!focused.has(branch)) {
                focused.add(branch);
                next.push({ focus: branch });
              }
            } else if (cursor && !seenCursors.has(cursor)) {
              seenCursors.add(cursor);
              next.push({ after: cursor, focus });
            }
            pending.set(branch, next);
          }
          if (!object(entry.node)) continue;
          const node = entry.node;
          const fullname = string(node.id);
          const content = object(node.content) ? node.content : null;
          const body = content && string(content.markdown);
          if (!fullname || !/^t1_[a-z0-9]+$/i.test(fullname) || !content || !body || body === "[deleted]" || body === "[removed]"
            || node.__typename === "DeletedComment" || node.isRemoved === true || node.isAdminTakedown === true) continue;
          const name = object(node.authorInfo) ? node.authorInfo.name : undefined;
          tree.add({ id: fullname, parentId, byAuthor: !!author && redditAuthor(name) === author, value: { node, content, body } });
        }
      } catch (error) {
        if (parent === rootId && tree.children().length < limit && !tree.children().some((reply) => reply.byAuthor)) throw error;
        break;
      }
    }
  }
  return tree.select(limit).map(({ id: fullname, value: { node, content, body } }) => {
    const metadata: Json = {};
    const media = Array.isArray(content.richtextMedia) ? content.richtextMedia.filter(object) : [];
    for (const asset of media) {
      const mediaId = string(asset.id);
      const url = string(asset.url);
      if (!mediaId || !url || (asset.status && asset.status !== "VALID")) continue;
      const mime = string(asset.mimetype);
      metadata[mediaId] = { m: mime, s: mime === "video/mp4" ? { mp4: url } : { u: url } };
    }
    // The API uses microseconds and offsets like +0000; normalize for JS dates.
    const createdAt = string(node.createdAt)?.replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    return redditComment({
      author: object(node.authorInfo) ? node.authorInfo.name : undefined,
      created_utc: createdAt ? Math.floor(Date.parse(createdAt) / 1000) : undefined,
      ups: node.score,
      media_metadata: metadata,
    }, fullname.slice(3), id, body);
  });
}

function redditComment(data: Json, id: string, postId: string, body: string): PostComment {
  const metadata = object(data.media_metadata) ? data.media_metadata : {};
  // Comment images/GIFs use the same rendition metadata as Reddit galleries.
  // Keep their inline order; do not treat arbitrary links as attachments.
  const mediaIds = Object.keys(metadata).filter((key) => object(metadata[key])).sort((left, right) => {
    const position = (key: string) => {
      const meta = metadata[key];
      const best = object(meta) && object(meta.s) ? meta.s : {};
      const tokens = [`![img](${key})`, `![gif](${key})`, string(best.u), string(best.gif), string(best.mp4)];
      const positions = tokens.flatMap((token) => token && body.includes(token) ? [body.indexOf(token)] : []);
      return Math.min(...positions);
    };
    return position(left) - position(right);
  });
  const items = galleryItems({ media_metadata: metadata, gallery_data: { items: mediaIds.map((media_id) => ({ media_id })) } }, id);
  const text = body.replace(/!\[(?:img|gif)\]\(([^)]+)\)/g, (match, key: string) => {
    const meta = metadata[key];
    return object(meta) && object(meta.s) && (string(meta.s.u) || string(meta.s.gif) || string(meta.s.mp4)) ? "" : match;
  }).split("\n").filter((line) => !items.some((item) => line.trim() === item.url)).join("\n").trim();
  const author = string(data.author);
  return {
    id,
    url: `https://www.reddit.com/comments/${postId}/_/${id}/`,
    items,
    metadata: {
      text,
      author: author && author !== "[deleted]" ? { handle: author } : undefined,
      createdAt: isoFromEpochSeconds(data.created_utc),
      likeCount: count(data.ups),
      nsfw: bool(data.over_18),
    },
  };
}
