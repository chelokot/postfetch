import { describe, expect, test } from "bun:test";
import { youtubeVideoId } from "../src/youtube";

describe("youtube url parsing", () => {
  test("extracts watch, shorts, live, embed and youtu.be ids", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=vPwaXytZcgI")).toBe("vPwaXytZcgI");
    expect(youtubeVideoId("https://www.youtube.com/shorts/r5FpeOJItbw")).toBe("r5FpeOJItbw");
    expect(youtubeVideoId("https://www.youtube.com/live/ENxZS6PUDuI?feature=shared")).toBe("ENxZS6PUDuI");
    expect(youtubeVideoId("https://www.youtube.com/embed/vPwaXytZcgI")).toBe("vPwaXytZcgI");
    expect(youtubeVideoId("https://youtu.be/vPwaXytZcgI")).toBe("vPwaXytZcgI");
  });

  test("rejects non-video youtube links", () => {
    expect(youtubeVideoId("https://www.youtube.com/@youtube")).toBeNull();
  });
});
