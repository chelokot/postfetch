import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

// Live tests hit the real platforms and are skipped unless POSTFETCH_LIVE=1.
// POSTFETCH_LIVE_PLATFORM narrows the run to one platform, so CI can give each
// platform its own job. They guard the regression that started this project: an
// Instagram reel that silently resolved to its cover image instead of the video.
const live = process.env.POSTFETCH_LIVE === "1";
const platform = process.env.POSTFETCH_LIVE_PLATFORM;

function runs(name: string): boolean {
  return live && (platform === undefined || platform === name);
}

const reel = "https://www.instagram.com/reel/DZ0ixNxtvYq/";

describe("live network", () => {
  test.skipIf(!runs("instagram"))(
    "instagram reel resolves to a video, not the cover image",
    async () => {
      const result = await postfetch(reel);
      expect(result.platform).toBe("instagram");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("instagram"))(
    "instagram rotating fingerprints are not all blocked",
    async () => {
      let videos = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await postfetch(reel);
        if (result.items[0]?.kind === "video") {
          videos += 1;
        }
      }
      expect(videos).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!runs("tiktok"))(
    "tiktok resolves a shortlink to a video",
    async () => {
      const result = await postfetch("https://vt.tiktok.com/ZSxpHvCUM/");
      expect(result.platform).toBe("tiktok");
      expect(result.items[0]?.kind).toBe("video");
    },
    30_000,
  );

  test.skipIf(!runs("youtube"))(
    "youtube short resolves to a progressive mp4 via the session bootstrap",
    async () => {
      const result = await postfetch("https://www.youtube.com/shorts/r5FpeOJItbw");
      expect(result.platform).toBe("youtube");
      expect(result.items[0]?.kind).toBe("video");
    },
    30_000,
  );
});
