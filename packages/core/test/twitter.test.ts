import { describe, expect, test } from "bun:test";
import { tweetId, twitterMetadata } from "../src/twitter";
import { postfetch } from "../src/index";

describe("twitter url parsing", () => {
  test("extracts the status id across handle, i/, suffix and query formats", () => {
    expect(tweetId("https://x.com/i/status/2034598055668769263")).toBe("2034598055668769263");
    expect(tweetId("https://x.com/phantompain281/status/2030252928682905845")).toBe("2030252928682905845");
    expect(tweetId("https://x.com/klara_sjo/status/2036281665748717831/video/1")).toBe("2036281665748717831");
    expect(tweetId("https://x.com/NothingIsArt/status/2054224375545565681?s=20")).toBe("2054224375545565681");
    expect(tweetId("https://twitter.com/jack/statuses/20")).toBe("20");
  });

  test("rejects non-status twitter links", () => {
    expect(tweetId("https://x.com/jack")).toBeNull();
    expect(tweetId("https://x.com/home")).toBeNull();
  });
});

describe("twitter full text", () => {
  const id = "2096623134094864846";
  const quotedId = "2096255497410118075";
  const preview = "p".repeat(275);
  const fullText = `${preview}\n\nThe rest of the post, including Unicode: 世界 🌍.\n${"x".repeat(100)}`;

  async function resolve(tweet: Record<string, unknown>, fallback: () => Response | Promise<Response>) {
    const requests: string[] = [];
    const result = await postfetch(`https://x.com/IterIntellectus/status/${id}?s=20`, {
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://cdn.syndication.twimg.com/tweet-result")) {
          return Response.json({ id_str: id, ...tweet });
        }
        return fallback();
      }) as typeof fetch,
    });
    return { result, requests };
  }

  test("prefers inline note text, then full_text, then text", () => {
    expect(twitterMetadata({ text: "preview", full_text: "complete" }).text).toBe("complete");
    expect(twitterMetadata({ text: "preview", full_text: "complete", note_tweet: { text: "note" } }).text).toBe("note");
    expect(twitterMetadata({ text: "preview", note_tweet: { note_tweet_results: { result: { text: "nested note" } } } }).text).toBe("nested note");
  });

  test("expands the reported post and its unmarked quote with one lookup, preserving media and metadata", async () => {
    const { result, requests } = await resolve({
      text: preview,
      note_tweet: { id: "note-id" },
      favorite_count: 123,
      user: { screen_name: "IterIntellectus" },
      mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/image.jpg" }],
      quoted_tweet: { id_str: quotedId, text: "q".repeat(277), user: { screen_name: "nayibbukele" } },
    }, () => Response.json({ code: 200, tweet: {
      id, text: "formatted text", raw_text: { text: fullText }, likes: 999,
      quote: { id: quotedId, text: "q".repeat(558) },
    } }));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(`https://api.fxtwitter.com/status/${id}`);
    expect(result.metadata?.text).toBe(fullText);
    expect(result.metadata?.likeCount).toBe(123);
    expect(result.metadata?.author?.handle).toBe("IterIntellectus");
    expect(result.items[0]?.url).toBe("https://pbs.twimg.com/image.jpg?name=orig");
    if (result.platform !== "twitter") throw new Error("Expected Twitter");
    expect(result.metadata?.extra?.quotedTweet?.metadata.text).toBe("q".repeat(558));
    expect(result.metadata?.extra?.quotedTweet?.metadata.author?.handle).toBe("nayibbukele");
  });

  test("fetches a long quote directly when the outer post is short", async () => {
    const { result, requests } = await resolve({
      text: "My comment", quoted_tweet: { id_str: quotedId, text: preview },
    }, () => Response.json({ code: 200, tweet: { id: quotedId, text: fullText } }));
    expect(requests[1]).toBe(`https://api.fxtwitter.com/status/${quotedId}`);
    expect(result.metadata?.text).toBe("My comment");
    if (result.platform !== "twitter") throw new Error("Expected Twitter");
    expect(result.metadata?.extra?.quotedTweet?.metadata.text).toBe(fullText);
  });

  test.each([
    { text: "Short post" },
    { text: preview, full_text: fullText },
    { text: preview, note_tweet: { text: fullText } },
  ])("does not fetch a fallback when complete text is already available: %j", async (tweet) => {
    const { requests, result } = await resolve(tweet, () => { throw new Error("Unexpected lookup"); });
    expect(requests).toHaveLength(1);
    expect(result.metadata?.text).toBe(twitterMetadata(tweet).text);
  });

  test("uses the long-post marker even with a short preview", async () => {
    const { result } = await resolve({ text: "Short preview", note_tweet: { id: "note" } },
      () => Response.json({ code: 200, tweet: { id, text: fullText } }));
    expect(result.metadata?.text).toBe(fullText);
    expect(result.items).toEqual([]);
  });

  test.each([
    ["HTTP failure", () => new Response(null, { status: 503 })],
    ["network failure", () => { throw new Error("offline"); }],
    ["invalid JSON", () => new Response("not JSON")],
    ["invalid payload", () => Response.json(null)],
    ["API error", () => Response.json({ code: 404, tweet: { id, text: fullText } })],
    ["wrong post", () => Response.json({ code: 200, tweet: { id: "other", text: fullText } })],
    ["missing text", () => Response.json({ code: 200, tweet: { id } })],
    ["shorter text", () => Response.json({ code: 200, tweet: { id, text: "short" } })],
    ["unchanged preview", () => Response.json({ code: 200, tweet: { id, text: preview } })],
  ] as const)("preserves the syndication result on %s", async (_, fallback) => {
    const { result, requests } = await resolve({ text: preview, note_tweet: { id: "note" } }, fallback);
    expect(result.metadata?.text).toBe(preview);
    expect(result.items).toEqual([]);
    expect(requests).toHaveLength(2);
  });
});
