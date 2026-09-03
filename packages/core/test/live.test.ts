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
const reportedInstagramReel = "https://www.instagram.com/reel/Dau5MYHtudW/?igsh=MWh1aTRndjRtY2Z0";
const reportedInstagramPhotos = [
  "https://www.instagram.com/p/Da5HvHpSSse/?igsh=MWM1eXNjcWhwejAydA==",
  "https://www.instagram.com/p/DacyagKRdrE/?igsh=Ym5ocmh2bnZiMTg5",
];

describe("live network", () => {
  test.skipIf(!runs("instagram"))(
    "instagram reel resolves to a video, not the cover image",
    async () => {
      const result = await postfetch(reel);
      expect(result.platform).toBe("instagram");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.author?.handle).toBeTruthy();
      expect(result.metadata?.createdAt).toBeTruthy();
    },
    30_000,
  );

  test.skipIf(!runs("instagram"))(
    "reported instagram reel resolves to its video",
    async () => {
      const result = await postfetch(reportedInstagramReel);
      expect(result.platform).toBe("instagram");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.text).toContain("САМОГОН");
    },
    30_000,
  );

  test.skipIf(!runs("instagram"))(
    "reported instagram photo posts remain downloadable",
    async () => {
      for (const url of reportedInstagramPhotos) {
        const result = await postfetch(url);
        expect(result.platform).toBe("instagram");
        expect(result.metadata?.author?.handle).toBe("pibblestack.studio");
        expect(result.items.length).toBeGreaterThan(0);
        for (const item of result.items) {
          expect(item.kind).toBe("image");
          expect(item.mime).toBe("image/jpeg");
          const bytes = new Uint8Array(await (await download(item)).arrayBuffer());
          expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        }
      }
    },
    60_000,
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
      expect(result.metadata?.title).toBe("Seen in the UK");
      expect(result.metadata?.author?.handle).toBeTruthy();
      expect(typeof result.metadata?.likeCount).toBe("number");
      if (result.platform === "reddit") {
        expect(result.metadata?.extra?.subreddit).toBe("pics");
      }
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

  test.skipIf(!runs("reddit"))(
    "reddit text post resolves to metadata with no media",
    async () => {
      const result = await postfetch("https://www.reddit.com/r/AllClad/comments/1uednos/one_d5_12_inch_frying_pan_for_199_or_two_d3/");
      expect(result.platform).toBe("reddit");
      expect(result.items).toHaveLength(0);
      expect(result.metadata?.title).toBeTruthy();
      expect(result.metadata?.text).toBeTruthy();
    },
    30_000,
  );

  test.skipIf(!runs("pinterest"))(
    "pinterest video pin resolves to a progressive mp4",
    async () => {
      const result = await postfetch("https://www.pinterest.com/pin/3025924746345838/");
      expect(result.platform).toBe("pinterest");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.title).toBeTruthy();
      if (result.platform === "pinterest") {
        expect(typeof result.metadata?.extra?.saveCount).toBe("number");
      }
    },
    30_000,
  );

  test.skipIf(!runs("pinterest"))(
    "pinterest idea pin assembles its HLS video and audio into one mp4",
    async () => {
      const result = await postfetch("https://www.pinterest.com/pin/8303580559742266/");
      const item = result.items[0];
      expect(item?.hls).toBe(true);
      expect(item?.audio?.url).toBeDefined();
      if (!item) {
        throw new Error("no item");
      }
      const merged = new Uint8Array(await (await download(item)).arrayBuffer());
      expect(String.fromCharCode(merged[4], merged[5], merged[6], merged[7])).toBe("ftyp");
    },
    60_000,
  );

  test.skipIf(!runs("soundcloud"))(
    "soundcloud track resolves to a progressive mp3",
    async () => {
      const result = await postfetch("https://soundcloud.com/alexxlofi/khong-buong-lofi-ver-hngle-x");
      expect(result.platform).toBe("soundcloud");
      expect(result.items[0]?.kind).toBe("audio");
      expect(result.items[0]?.mime).toBe("audio/mpeg");
      expect(result.metadata?.title).toBeTruthy();
      expect(result.metadata?.author?.handle).toBeTruthy();
      expect(typeof result.metadata?.viewCount).toBe("number");
    },
    30_000,
  );

  test.skipIf(!runs("tiktok"))(
    "tiktok vt.tiktok.com shortlink resolves to a video",
    async () => {
      const result = await postfetch("https://vt.tiktok.com/ZSxpHvCUM/");
      expect(result.platform).toBe("tiktok");
      expect(result.items[0]?.kind).toBe("video");
    },
    30_000,
  );

  test.skipIf(!runs("tiktok"))(
    "tiktok vm.tiktok.com shortlink resolves to a video",
    async () => {
      const result = await postfetch("https://vm.tiktok.com/ZNRwhV7G2/");
      expect(result.platform).toBe("tiktok");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.metadata?.author?.handle).toBeTruthy();
      expect(typeof result.metadata?.likeCount).toBe("number");
      expect(typeof result.metadata?.viewCount).toBe("number");
    },
    30_000,
  );

  test.skipIf(!runs("tiktok"))(
    "reported tiktok vm shortlink resolves to a video",
    async () => {
      const result = await postfetch("https://vm.tiktok.com/ZN81BamTW/");
      expect(result.platform).toBe("tiktok");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.metadata?.text).toContain("котлеты");
      const item = result.items[0];
      if (!item) {
        throw new Error("no item");
      }
      const bytes = new Uint8Array(await (await download(item)).arrayBuffer());
      expect(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])).toBe("ftyp");
    },
    30_000,
  );

  test.skipIf(!runs("tiktok"))(
    "tiktok photo post resolves to its slideshow images",
    async () => {
      const result = await postfetch("https://www.tiktok.com/@lololokek0/photo/7657068534756838664");
      expect(result.platform).toBe("tiktok");
      expect(result.items.some((item) => item.kind === "image")).toBe(true);
    },
    30_000,
  );

  // watch, shorts and youtu.be all collapse to the same video id, and each
  // shape goes through the same session bootstrap behind YouTube's bot gate.
  test.skipIf(!runs("youtube"))(
    "youtube watch link resolves to a progressive mp4 via the session bootstrap",
    async () => {
      const result = await postfetch("https://www.youtube.com/watch?v=jNQXAC9IVRw");
      expect(result.platform).toBe("youtube");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.metadata?.title).toBeTruthy();
      expect(result.metadata?.author?.name).toBeTruthy();
      expect(typeof result.metadata?.viewCount).toBe("number");
      if (result.platform === "youtube") {
        expect(result.metadata?.extra?.channelId).toBeTruthy();
      }
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

  test.skipIf(!runs("youtube"))(
    "youtube youtu.be shortlink resolves to a progressive mp4 via the session bootstrap",
    async () => {
      const result = await postfetch("https://youtu.be/VYXAND8enUo");
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

  test.skipIf(!runs("linkedin"))(
    "linkedin public post resolves its highest-bitrate video and metadata",
    async () => {
      const result = await postfetch("https://www.linkedin.com/posts/microsoft-security_watch-the-video-activity-7163247035113013249-ltdX");
      expect(result.platform).toBe("linkedin");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.author).toMatchObject({ handle: "microsoft-security", name: "Microsoft Security" });
      expect(result.metadata?.text).toContain("Zero Trust");
      expect(result.metadata?.createdAt).toBe("2024-02-13T19:06:19.833Z");
      expect(typeof result.metadata?.likeCount).toBe("number");
      const item = result.items[0];
      if (!item) {
        throw new Error("no item");
      }
      const bytes = new Uint8Array(await (await download(item)).arrayBuffer());
      expect(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])).toBe("ftyp");
    },
    30_000,
  );

  test.skipIf(!runs("linkedin"))(
    "linkedin public image post resolves its image and metadata",
    async () => {
      const result = await postfetch("https://www.linkedin.com/posts/linkedin_how-linkedin-built-the-engineering-infrastructure-activity-7137778336952438784-iDcc");
      expect(result.platform).toBe("linkedin");
      expect(result.items[0]?.kind).toBe("image");
      expect(result.items[0]?.mime).toBe("image/jpeg");
      expect(result.metadata?.author).toMatchObject({ handle: "linkedin", name: "LinkedIn" });
      expect(result.metadata?.text).toContain("knowledge sharing");
      const item = result.items[0];
      if (!item) {
        throw new Error("no item");
      }
      const bytes = new Uint8Array(await (await download(item)).arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    },
    30_000,
  );

  test.skipIf(!runs("facebook"))(
    "facebook reel resolves to a video via the watch page",
    async () => {
      const result = await postfetch("https://www.facebook.com/share/r/18z2cXtUGM/");
      expect(result.platform).toBe("facebook");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.author?.name).toBeTruthy();
      expect(typeof result.metadata?.viewCount).toBe("number");
    },
    30_000,
  );

  // The same tweet can arrive as /i/status, /handle/status, with a /video/N
  // suffix, or with a tracking query — every shape collapses to the status id.
  test.skipIf(!runs("twitter"))(
    "x i/status link resolves to a video via syndication",
    async () => {
      const result = await postfetch("https://x.com/i/status/2034598055668769263");
      expect(result.platform).toBe("twitter");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
      expect(result.metadata?.text).toBeTruthy();
      expect(result.metadata?.author?.handle).toBeTruthy();
      expect(typeof result.metadata?.likeCount).toBe("number");
    },
    30_000,
  );

  test.skipIf(!runs("twitter"))(
    "x handle link with a /video/1 suffix resolves to a video",
    async () => {
      const result = await postfetch("https://x.com/klara_sjo/status/2036281665748717831/video/1");
      expect(result.platform).toBe("twitter");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("twitter"))(
    "x handle link with a tracking query resolves to a video",
    async () => {
      const result = await postfetch("https://x.com/NothingIsArt/status/2054224375545565681?s=20");
      expect(result.platform).toBe("twitter");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("twitter"))(
    "x handle status link resolves to a video",
    async () => {
      const result = await postfetch("https://x.com/phantompain281/status/2030252928682905845");
      expect(result.platform).toBe("twitter");
      expect(result.items[0]?.kind).toBe("video");
      expect(result.items[0]?.mime).toBe("video/mp4");
    },
    30_000,
  );

  test.skipIf(!runs("twitter"))(
    "x quote post includes media and metadata from the quoted post",
    async () => {
      const result = await postfetch("https://x.com/rehan_shei/status/2094955712606593294/video/1");
      if (result.platform !== "twitter") {
        throw new Error("expected a twitter result");
      }
      expect(result.items).toHaveLength(2);
      expect(result.items.map((item) => item.id)).toEqual(["2094955712606593294", "2094839756329041984"]);
      expect(result.items.every((item) => item.kind === "video")).toBe(true);
      expect(result.metadata?.text).toContain("Sports replays");
      expect(result.metadata?.extra?.quotedTweet?.id).toBe("2094839756329041984");
      expect(result.metadata?.extra?.quotedTweet?.metadata.text).toContain("Introducing Atlas");
    },
    30_000,
  );
});
