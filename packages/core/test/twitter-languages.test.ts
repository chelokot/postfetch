import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

const id = "1234567890";
const original = "こんにちは";
async function resolve(options: { languages?: string[]; lang?: string; translated?: (id: string, lang: string) => unknown; quote?: boolean; comments?: boolean } = {}) {
  const requests: string[] = [];
  const result = await postfetch(`https://x.com/i/status/${id}`, {
    languages: options.languages,
    comments: options.comments ? 1 : undefined,
    fetch: (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("syndication")) return Response.json({
        id_str: id, text: original, lang: options.lang ?? "ja",
        ...(options.quote && { quoted_tweet: { id_str: "42", text: "Привет", lang: "ru" }, parent: { id_str: "43", text: "Bonjour", lang: "fr" } }),
      });
      if (url.includes("/2/conversation/")) return Response.json({ code: 200, replies: [{ id: "44", text: "Hola", lang: "es", replying_to: { status: id } }] });
      const [, postId, language] = url.match(/\/status\/(\d+)\/([a-z-]+)$/) ?? [];
      if (!postId) throw new Error(`Unexpected ${url}`);
      const translation = options.translated?.(postId, language);
      if (translation instanceof Error) throw translation;
      return Response.json(translation ?? { code: 200, tweet: { id: postId, translation: { text: `Translated ${postId} to ${language}`, target_lang: language, source_lang: "ja" } } });
    }) as typeof fetch,
  });
  return { result, requests };
}

describe("X allowed text languages", () => {
  test("keeps originals by default and when their language is enabled, including regional tags", async () => {
    for (const options of [{}, { languages: ["en", "ja"] }, { languages: ["ja"], lang: "ja-jp" }]) {
      const { result, requests } = await resolve(options);
      expect(result.metadata?.text).toBe(original);
      expect(requests).toHaveLength(1);
    }
  });

  test("translates to the first language while retaining original text and language", async () => {
    const { result, requests } = await resolve({ languages: ["RU", "en"] });
    expect(requests[1]).toEndWith(`/${id}/ru`);
    expect(result.metadata).toMatchObject({ text: `Translated ${id} to ru`, extra: { lang: "ja", originalText: original, translatedLang: "ru" } });
  });

  test("falls back to English after a missing, invalid, wrong-language, or failed translation", async () => {
    for (const failure of [null, {}, { text: "", target_lang: "ru" }, { text: "Wrong", target_lang: "de" }, { text: "You're using an older version of DeepL. To continue using the app, please update to the latest version.", target_lang: "ru" }, new Error("offline")]) {
      const { result, requests } = await resolve({ languages: ["ru"], translated: (postId, language) => {
        if (language === "en") return { code: 200, tweet: { id: postId, translation: { text: "Hello", target_lang: "en" } } };
        return failure instanceof Error ? failure : { code: 200, tweet: { id: postId, translation: failure } };
      } });
      expect(result.metadata?.text).toBe("Hello");
      expect(requests.slice(1)).toEqual([`https://api.fxtwitter.com/status/${id}/ru`, `https://api.fxtwitter.com/status/${id}/en`]);
    }
  });

  test("falls back to original after both attempts and never repeats English", async () => {
    for (const languages of [["ru"], ["en"]]) {
      const { result, requests } = await resolve({ languages, translated: () => ({ code: 404 }) });
      expect(result.metadata?.text).toBe(original);
      expect(requests).toHaveLength(languages[0] === "en" ? 2 : 3);
    }
  });

  test("translates quotes, parents and requested replies independently", async () => {
    const { result } = await resolve({ languages: ["en", "ru"], quote: true, comments: true });
    if (result.platform !== "twitter") throw new Error("Expected X");
    expect(result.metadata?.extra?.quotedTweet?.metadata.text).toBe("Привет");
    expect(result.metadata?.extra?.parentTweet?.metadata.text).toBe("Translated 43 to en");
    expect(result.comments[0].metadata.text).toBe("Translated 44 to en");
  });

  test("does not accept a different post's translation", async () => {
    const { result } = await resolve({ languages: ["en"], translated: () => ({ code: 200, tweet: { id: "wrong", translation: { text: "Wrong post", target_lang: "en" } } }) });
    expect(result.metadata?.text).toBe(original);
  });

  test("validates preferences before fetching", async () => {
    for (const languages of [[], [""], ["../en"], ["en,ru"]]) await expect(resolve({ languages })).rejects.toThrow("languages must");
  });
});
