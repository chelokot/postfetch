import { describe, expect, test } from "bun:test";
import { HttpError, detect } from "../src";

describe("public api", () => {
  test("detects supported platforms", () => {
    expect(detect("https://vt.tiktok.com/ZSxpHvCUM/")).toBe("tiktok");
    expect(detect("https://www.instagram.com/reel/DNoW_6xygMC/")).toBe("instagram");
    expect(detect("https://www.youtube.com/shorts/r5FpeOJItbw")).toBe("youtube");
    expect(detect("https://youtu.be/r5FpeOJItbw")).toBe("youtube");
  });

  test("rejects unsupported platforms with an HTTP error", () => {
    expect(() => detect("https://example.com/post")).toThrow(HttpError);
  });
});
