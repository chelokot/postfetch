import { describe, expect, test } from "bun:test";
import { asUrl, filename } from "../src/core";

describe("core helpers", () => {
  test("normalizes filenames for content-disposition", () => {
    expect(filename("youtube: hello/world?.mp4")).toBe("youtube_hello_world_.mp4");
  });

  test("rejects invalid URLs", () => {
    expect(() => asUrl("not a url")).toThrow("invalid url");
  });
});
