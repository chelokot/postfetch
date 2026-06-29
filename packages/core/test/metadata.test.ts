import { describe, expect, test } from "bun:test";
import { instagramMetadata } from "../src/instagram";
import { pinterestMetadata } from "../src/pinterest";
import { redditMetadata } from "../src/reddit";
import { soundcloudMetadata } from "../src/soundcloud";
import { tiktokMetadata } from "../src/tiktok";
import { twitterMetadata } from "../src/twitter";
import { youtubeMetadata } from "../src/youtube";

// Fixtures are trimmed copies of the real payloads each resolver already fetches.

describe("reddit metadata", () => {
  test("maps title, author, score and counts", () => {
    const meta = redditMetadata({
      title: "Seen in the UK",
      selftext: "",
      author: "Gertrudethecurious",
      subreddit: "pics",
      ups: 9969,
      score: 9969,
      upvote_ratio: 0.97,
      num_comments: 251,
      created_utc: 1782557495,
      over_18: false,
      permalink: "/r/pics/comments/1ugzn9p/seen_in_the_uk/",
    });
    expect(meta).toEqual({
      title: "Seen in the UK",
      text: undefined,
      author: { handle: "Gertrudethecurious" },
      createdAt: "2026-06-27T10:51:35.000Z",
      likeCount: 9969,
      commentCount: 251,
      nsfw: false,
      extra: { subreddit: "pics", score: 9969, upvoteRatio: 0.97, permalink: "/r/pics/comments/1ugzn9p/seen_in_the_uk/" },
    });
  });
});

describe("twitter metadata", () => {
  test("maps text, author, likes and replies; retweets become shares", () => {
    const meta = twitterMetadata({
      text: "The truth about solar and wind power",
      user: { name: "N. Schmid", screen_name: "N_Schmid", verified: false },
      favorite_count: 1534,
      conversation_count: 31,
      retweet_count: 12,
      view_count: null,
      created_at: "2026-03-19T11:49:12.000Z",
      lang: "en",
      possibly_sensitive: false,
    });
    expect(meta).toEqual({
      text: "The truth about solar and wind power",
      author: { handle: "N_Schmid", name: "N. Schmid", verified: false },
      createdAt: "2026-03-19T11:49:12.000Z",
      likeCount: 1534,
      commentCount: 31,
      shareCount: 12,
      viewCount: undefined,
      nsfw: false,
      extra: { lang: "en" },
    });
  });

  test("falls back to blue verification and leaves missing counts undefined", () => {
    const meta = twitterMetadata({ text: "hi", user: { screen_name: "x", is_blue_verified: true } });
    expect(meta.author).toEqual({ handle: "x", name: undefined, verified: true });
    expect(meta.likeCount).toBeUndefined();
    expect(meta.shareCount).toBeUndefined();
  });
});

describe("tiktok metadata", () => {
  test("maps stats, collects-as-saves, music and duration", () => {
    const meta = tiktokMetadata({
      desc: "a clip",
      createTime: "1782634815",
      author: { uniqueId: "mslfnvm", nickname: "mmmmash", verified: false },
      stats: { diggCount: 5447, commentCount: 59, shareCount: 2845, playCount: 129700, collectCount: "588" },
      music: { title: "original sound", authorName: "SpongeBob background music" },
      video: { duration: 9 },
      locationCreated: "CZ",
    });
    expect(meta).toEqual({
      text: "a clip",
      author: { handle: "mslfnvm", name: "mmmmash", verified: false },
      createdAt: "2026-06-28T08:20:15.000Z",
      likeCount: 5447,
      commentCount: 59,
      shareCount: 2845,
      viewCount: 129700,
      extra: { saveCount: 588, musicTitle: "original sound", musicAuthor: "SpongeBob background music", region: "CZ", durationSeconds: 9 },
    });
  });
});

describe("youtube metadata", () => {
  test("reads string counts, derives duration, keeps keywords; no microformat means no date", () => {
    const meta = youtubeMetadata({
      videoDetails: {
        title: "Me at the zoo",
        author: "jawed",
        channelId: "UC4QobU6STFB0P71PMvOGN5A",
        viewCount: "397116984",
        lengthSeconds: "19",
        shortDescription: "The first video",
        keywords: ["zoo", "elephants"],
      },
    });
    expect(meta).toEqual({
      title: "Me at the zoo",
      text: "The first video",
      author: { name: "jawed" },
      createdAt: undefined,
      viewCount: 397116984,
      extra: { channelId: "UC4QobU6STFB0P71PMvOGN5A", durationSeconds: 19, keywords: ["zoo", "elephants"] },
    });
  });

  test("reads publishDate from the microformat when present", () => {
    const meta = youtubeMetadata({
      videoDetails: { title: "t", author: "a" },
      microformat: { playerMicroformatRenderer: { publishDate: "2005-04-23" } },
    });
    expect(meta.createdAt).toBe("2005-04-23T00:00:00.000Z");
  });
});

describe("soundcloud metadata", () => {
  test("maps counts and converts duration from milliseconds to seconds", () => {
    const meta = soundcloudMetadata({
      title: "Không Buông (Lofi Ver.)",
      description: "",
      genre: "Lofi",
      user: { username: "Duc Truong Nguyen", full_name: "" },
      playback_count: 1674959,
      likes_count: 11299,
      comment_count: 69,
      reposts_count: 213,
      created_at: "2025-09-27T04:47:19Z",
      duration: 203200,
      license: "all-rights-reserved",
    });
    expect(meta).toEqual({
      title: "Không Buông (Lofi Ver.)",
      text: undefined,
      author: { handle: "Duc Truong Nguyen", name: undefined },
      createdAt: "2025-09-27T04:47:19.000Z",
      likeCount: 11299,
      commentCount: 69,
      shareCount: 213,
      viewCount: 1674959,
      extra: { genre: "Lofi", license: "all-rights-reserved", durationSeconds: 203 },
    });
  });
});

describe("pinterest metadata", () => {
  test("sums reactions into likes, repins into saves, parses an RFC 2822 date", () => {
    const meta = pinterestMetadata({
      title: "Healthy Buffalo Chicken Cucumber Rolls",
      description: "Snack smart",
      pinner: { username: "amgeff44", full_name: "Amanda Gooch" },
      repin_count: 28446,
      comment_count: 0,
      reaction_counts: { "1": 6183, "2": 17 },
      created_at: "Mon, 20 Oct 2025 03:08:47 +0000",
      dominant_color: "#a88b67",
      link: null,
    });
    expect(meta).toEqual({
      title: "Healthy Buffalo Chicken Cucumber Rolls",
      text: "Snack smart",
      author: { handle: "amgeff44", name: "Amanda Gooch" },
      createdAt: "2025-10-20T03:08:47.000Z",
      likeCount: 6200,
      commentCount: 0,
      extra: { saveCount: 28446, dominantColor: "#a88b67", outboundLink: undefined },
    });
  });
});

describe("instagram metadata", () => {
  test("maps the logged-out shape with caption object and counts", () => {
    const meta = instagramMetadata({
      caption: { text: "summer" },
      like_count: 16301,
      comment_count: 119,
      like_and_view_counts_disabled: false,
      taken_at: 1781987126,
      product_type: "clips",
      user: { username: "avolind", full_name: "Анна Данилова", is_verified: false },
    });
    expect(meta).toEqual({
      text: "summer",
      author: { handle: "avolind", name: "Анна Данилова", verified: false },
      createdAt: "2026-06-20T20:25:26.000Z",
      likeCount: 16301,
      commentCount: 119,
      viewCount: undefined,
      extra: { productType: "clips", countsHidden: false, location: undefined },
    });
  });

  test("hides like and view counts when the account disabled them", () => {
    const meta = instagramMetadata({
      like_count: 16301,
      comment_count: 119,
      play_count: 5000,
      like_and_view_counts_disabled: true,
      user: { username: "avolind" },
    });
    expect(meta.likeCount).toBeUndefined();
    expect(meta.viewCount).toBeUndefined();
    expect(meta.commentCount).toBe(119);
    expect(meta.extra?.countsHidden).toBe(true);
  });

  test("falls back to the GraphQL shape (owner, edges)", () => {
    const meta = instagramMetadata({
      owner: { username: "natgeo", full_name: "National Geographic", is_verified: true },
      edge_media_to_caption: { edges: [{ node: { text: "a lion" } }] },
      edge_media_preview_like: { count: 42 },
      edge_media_to_comment: { count: 7 },
      video_view_count: 999,
      taken_at_timestamp: 1781987126,
    });
    expect(meta.text).toBe("a lion");
    expect(meta.author).toEqual({ handle: "natgeo", name: "National Geographic", verified: true });
    expect(meta.likeCount).toBe(42);
    expect(meta.commentCount).toBe(7);
    expect(meta.viewCount).toBe(999);
  });
});
