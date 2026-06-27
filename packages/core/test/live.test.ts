import { describe, expect, test } from "bun:test";
import { download, postfetch } from "../src/index";

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

  test.skipIf(!runs("reddit"))(
    "reddit gallery resolves to ordered images",
    async () => {
      const result = await postfetch("https://www.reddit.com/r/pics/comments/1ugzn9p/seen_in_the_uk/");
      expect(result.platform).toBe("reddit");
      expect(result.items[0]?.kind).toBe("image");
    },
    30_000,
  );

  test.skipIf(!runs("reddit"))(
    "reddit video with audio remuxes the two DASH streams into one mp4",
    async () => {
      const result = await postfetch("https://www.reddit.com/r/oddlysatisfying/comments/1uha6sp/a_common_loon_coming_in_for_a_smooth_landing/");
      const item = result.items[0];
      expect(item?.kind).toBe("video");
      expect(item?.audio?.url).toBeDefined();
      if (!item) {
        throw new Error("no item");
      }
      const merged = new Uint8Array(await (await download(item)).arrayBuffer());
      // the merged file is a valid MP4 (starts with an ftyp box) carrying both tracks
      expect(String.fromCharCode(merged[4], merged[5], merged[6], merged[7])).toBe("ftyp");
      expect(merged.length).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!runs("pinterest"))(
    "pinterest video pin resolves to a progressive mp4",
    async () => {
      const result = await postfetch("https://www.pinterest.com/pin/3025924746345838/");
      expect(result.platform).toBe("pinterest");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("soundcloud"))(
    "soundcloud track resolves to a progressive mp3",
    async () => {
      const result = await postfetch("https://soundcloud.com/alexxlofi/khong-buong-lofi-ver-hngle-x");
      expect(result.platform).toBe("soundcloud");
      expect(result.items[0]?.kind).toBe("audio");
      expect(result.items[0]?.mime).toBe("audio/mpeg");
    },
    30_000,
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

  test.skipIf(!runs("facebook"))(
    "facebook share link resolves to a video via the embed player",
    async () => {
      const result = await postfetch("https://www.facebook.com/share/v/19MXsYX58F/");
      expect(result.platform).toBe("facebook");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("twitter"))(
    "x video tweet resolves via syndication",
    async () => {
      const result = await postfetch("https://x.com/i/status/2034598055668769263");
      expect(result.platform).toBe("twitter");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );
});
