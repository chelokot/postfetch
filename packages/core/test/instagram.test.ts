import { describe, expect, test } from "bun:test";
import { instagramUnavailableReason } from "../src/instagram";
import { postfetch } from "../src/index";

describe("instagram unavailable reason", () => {
  test("reads the age block from the oembed body", () => {
    const body = JSON.stringify({
      message: "geoblock_required",
      title: "People under 18 can't see this content",
      blocks_logging_data: "MIN_AGE_ACCOUNT",
      status: "fail",
    });
    expect(instagramUnavailableReason(400, body)).toBe("ageRestricted");
  });

  test("maps a 404 to a removed post and a 429 to throttling", () => {
    expect(instagramUnavailableReason(404, "")).toBe("notFound");
    expect(instagramUnavailableReason(429, "")).toBe("rateLimited");
  });

  test("maps a 404 for a private share-link shortcode to a private post", () => {
    expect(instagramUnavailableReason(404, "No Media Match", "Dez5H6Ojs7nPXbj07KMfMe1Ftsfhs7m1MFHsRg0")).toBe("private");
    expect(instagramUnavailableReason(404, "No Media Match", "Dez5H6Ojs7n")).toBe("notFound");
  });

  test("detects private accounts and login walls", () => {
    expect(instagramUnavailableReason(400, "This account is private")).toBe("private");
    expect(instagramUnavailableReason(401, "Please log in to continue")).toBe("loginRequired");
  });

  test("falls back to unavailable when the post is reachable or the cause is unknown", () => {
    expect(instagramUnavailableReason(200, "{}")).toBe("unavailable");
    expect(instagramUnavailableReason(400, "{}")).toBe("unavailable");
    expect(instagramUnavailableReason(400, JSON.stringify({ message: "geoblock_required" }))).toBe("unavailable");
  });
});

describe("instagram media fallbacks", () => {
  test.each([
    ["the requested post's age gate", "Dd6GlX7MYad", "Age-restricted content", "ageRestricted", 451],
    ["another post's age gate", "OTHER", "Age-restricted content", "unavailable", 404],
    ["an unspecified audience gate", "Dd6GlX7MYad", "This content isn't available to everyone", "unavailable", 404],
  ] as const)("classifies %s when oembed has no age marker", async (_label, gatedCode, title, reason, status) => {
    const code = "Dd6GlX7MYad";
    const page = `<script type="application/json">${JSON.stringify({
      data: {
        media: {
          __typename: "XIGPolarisVideoMedia",
          code: gatedCode,
          if_not_gated_logged_out: null,
          gating_ruling: { gating_type: 3, title },
        },
      },
    })}</script>`;
    const injectedFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://www.instagram.com/p/${code}/`) {
        return new Response(page);
      }
      if (url.startsWith("https://i.instagram.com/api/v1/oembed/")) {
        return Response.json({
          message: "geoblock_required",
          gating_type: "unappealable",
          title: "This content isn't available to everyone",
          description: "It can't be seen by certain audiences.",
          blocks_logging_data: "",
          status: "fail",
        }, { status: 400 });
      }
      if (url === "https://www.instagram.com/graphql/query") {
        return Response.json({ data: null });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    await expect(postfetch(`https://www.instagram.com/reel/${code}/`, { fetch: injectedFetch }))
      .rejects.toMatchObject({ name: "PostfetchError", reason, status });
  });

  test("does not return a reel cover when the current GraphQL query has the video", async () => {
    const code = "REEL1";
    const cover = `<script type="application/json">${JSON.stringify({
      media: {
        code,
        media_type: 2,
        gating_ruling: { title: "Age-restricted content" },
        image_versions2: { candidates: [{ url: "https://cdn.test/cover.jpg" }] },
      },
    })}</script>`;
    const requests: Array<{ body: string; url: string }> = [];
    const injectedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ body: init?.body?.toString() ?? "", url });
      if (url === `https://www.instagram.com/p/${code}/`) {
        return new Response(cover, { headers: { "set-cookie": "csrftoken=test; Path=/" } });
      }
      if (url.startsWith("https://i.instagram.com/api/v1/oembed/")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/embed/captioned/")) {
        return new Response("", { status: 404 });
      }
      if (url === "https://www.instagram.com/graphql/query") {
        return Response.json({
          data: {
            xdt_api__v1__media__shortcode__web_info: {
              items: [{ code, media_type: 2, video_versions: [{ width: 720, url: "https://cdn.test/reel.mp4" }] }],
            },
          },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const result = await postfetch(`https://www.instagram.com/reel/${code}/`, { fetch: injectedFetch });

    expect(result.items).toEqual([expect.objectContaining({ kind: "video", url: "https://cdn.test/reel.mp4" })]);
    const graphql = requests.find((request) => request.url === "https://www.instagram.com/graphql/query");
    expect(graphql?.body).toContain("doc_id=26130443479876713");
    expect(graphql?.body).toContain("fb_api_req_friendly_name=PolarisPostRootQuery");
  });
});

describe("instagram photo soundtracks", () => {
  const code = "MUSIC1";
  const photo = { code, pk: "123", image_versions2: { candidates: [{ url: "https://cdn.test/photo.jpg" }] } };
  const licensed = {
    music_info: {
      music_asset_info: { progressive_download_url: "https://cdn.test/song.m4a" },
      music_consumption_info: { audio_asset_start_time_in_ms: 12500, overlap_duration_in_ms: 7500 },
    },
  };

  async function resolve(media: Record<string, unknown>, mobile?: Record<string, unknown> | Error) {
    const requests: string[] = [];
    const injectedFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === `https://www.instagram.com/p/${code}/`) {
        return new Response(`<script type="application/json">${JSON.stringify({ media })}</script>`);
      }
      if (url === "https://i.instagram.com/api/v1/media/123/info/") {
        if (mobile instanceof Error) throw mobile;
        return mobile ? Response.json({ items: [mobile] }) : new Response("login_required", { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    return { result: await postfetch(`https://www.instagram.com/p/${code}/`, { fetch: injectedFetch }), requests };
  }

  test("normalizes a single photo and its selected music segment to visual + audio", async () => {
    const { result, requests } = await resolve({ ...photo, music_metadata: licensed });
    expect(result.items.map((item) => item.kind)).toEqual(["image", "audio"]);
    expect(result.items[1]).toMatchObject({
      filename: "instagram_MUSIC1_audio.m4a", platform: "instagram", mime: "audio/mp4",
      url: "https://cdn.test/song.m4a", clip: { start: 12.5, duration: 7.5 },
    });
    expect(requests).toHaveLength(1);
  });

  test.each(["carousel_media", "edge_sidecar_to_children"])("appends one original soundtrack to %s in visual order", async (shape) => {
    const visuals = [photo, { video_versions: [{ width: 720, url: "https://cdn.test/clip.mp4" }] }];
    const { result } = await resolve({
      ...photo,
      [shape]: shape === "carousel_media" ? visuals : { edges: visuals.map((node) => ({ node })) },
      music_metadata: { original_sound_info: { fast_start_progressive_download_url: "https://cdn.test/original.m4a" } },
    });
    expect(result.items.map((item) => item.kind)).toEqual(["image", "video", "audio"]);
    expect(result.items[2].url).toBe("https://cdn.test/original.m4a");
    expect(result.items[2].clip).toBeUndefined();
  });

  test("enriches a sparse page without replacing its photo or caption", async () => {
    const { result, requests } = await resolve({ ...photo, caption: "Page caption", clips_metadata: null }, {
      ...photo, image_versions2: { candidates: [{ url: "https://cdn.test/smaller.jpg" }] }, music_metadata: licensed,
    });
    expect(result.items.map((item) => item.kind)).toEqual(["image", "audio"]);
    expect(result.items[0].url).toBe("https://cdn.test/photo.jpg");
    expect(result.metadata?.text).toBe("Page caption");
    expect(requests).toEqual([`https://www.instagram.com/p/${code}/`, "https://i.instagram.com/api/v1/media/123/info/"]);
  });

  test("ignores soundtrack data for a different post", async () => {
    const { result } = await resolve(photo, { ...photo, code: "OTHER", music_metadata: licensed });
    expect(result.items.map((item) => item.kind)).toEqual(["image"]);
  });

  test.each([undefined, new Error("connection failed")])("keeps the photo when optional enrichment is unavailable (%s)", async (mobile) => {
    const { result } = await resolve(photo, mobile);
    expect(result.items.map((item) => item.kind)).toEqual(["image"]);
  });

  test("does not replace a video's own audio with its attributed song", async () => {
    const { result, requests } = await resolve({
      ...photo, video_versions: [{ width: 720, url: "https://cdn.test/video.mp4" }], clips_metadata: licensed,
    });
    expect(result.items.map((item) => item.kind)).toEqual(["video"]);
    expect(requests).toHaveLength(1);
  });

  test.each([
    null,
    {},
    { music_info: { music_asset_info: { progressive_download_url: "" } } },
    { music_info: { music_asset_info: { progressive_download_url: "not-a-url" } } },
    { music_info: { music_asset_info: { web_30s_preview_download_url: "https://cdn.test/preview.m4a" } } },
    { ...licensed, music_info: { ...licensed.music_info, music_consumption_info: { should_mute_audio: true } } },
  ])("does not invent or preview a missing/unavailable soundtrack (%j)", async (music_metadata) => {
    const { result, requests } = await resolve({ ...photo, music_metadata });
    expect(result.items.map((item) => item.kind)).toEqual(["image"]);
    expect(requests).toHaveLength(1);
  });
});
