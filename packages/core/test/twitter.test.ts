import { describe, expect, test } from "bun:test";
import { tweetId } from "../src/twitter";

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
