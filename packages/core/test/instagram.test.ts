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

  test("detects private accounts and login walls", () => {
    expect(instagramUnavailableReason(400, "This account is private")).toBe("private");
    expect(instagramUnavailableReason(401, "Please log in to continue")).toBe("loginRequired");
  });

  test("falls back to unavailable when the post is reachable or the cause is unknown", () => {
    expect(instagramUnavailableReason(200, "{}")).toBe("unavailable");
    expect(instagramUnavailableReason(400, "{}")).toBe("unavailable");
  });
});

describe("instagram media fallbacks", () => {
  test("does not return a reel cover when the current GraphQL query has the video", async () => {
    const code = "REEL1";
    const cover = `<script type="application/json">${JSON.stringify({
      media: { code, media_type: 2, image_versions2: { candidates: [{ url: "https://cdn.test/cover.jpg" }] } },
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
