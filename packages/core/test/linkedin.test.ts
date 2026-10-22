import { describe, expect, test } from "bun:test";
import { postfetch } from "../src/index";

function stubPage(html: string, requested: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    return new Response(html, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

describe("linkedin", () => {
  test("expands lnkd.in post and legacy shortlinks before resolving canonical media", async () => {
    const id = "7518607231823728641";
    const pageUrl = "https://www.linkedin.com/feed/update/urn:li:ugcPost:7518607188127596544";
    const post = {
      "@type": "VideoObject",
      "@id": `https://www.linkedin.com/posts/danilo-giudice_revenue-activity-${id}-A5uq`,
      contentUrl: "https://cdn.test/video.mp4",
      description: "Revenue: $16.3B",
      creator: { name: "Danilo Giudice", url: "https://it.linkedin.com/in/danilo-giudice" },
    };
    for (const shortUrl of ["https://lnkd.in/p/dCMkSApV", "https://lnkd.in/dCMkSApV?trk=share"]) {
      const requested: string[] = [];
      const result = await postfetch(shortUrl, {
        fetch: (async (input, init) => {
          const url = String(input);
          requested.push(url);
          if (url === shortUrl) {
            expect(init?.redirect).toBe("manual");
            expect(new Headers(init?.headers).get("user-agent")).toBeTruthy();
            return new Response(null, {
              status: 301,
              headers: { location: "https://www.linkedin.com/posts/danilo-giudice_revenue-ugcPost-7518607188127596544-yYp-/?utm_source=share" },
            });
          }
          expect(url).toBe(pageUrl);
          return new Response(`<script type="application/ld+json">${JSON.stringify(post)}</script>`);
        }) as typeof fetch,
      });

      expect(requested).toEqual([shortUrl, pageUrl]);
      expect(result).toMatchObject({
        id,
        platform: "linkedin",
        archiveFilename: `linkedin_${id}.zip`,
        items: [{ id, filename: `linkedin_${id}.mp4`, kind: "video", url: "https://cdn.test/video.mp4", headers: { referer: pageUrl } }],
        metadata: { text: "Revenue: $16.3B", author: { handle: "danilo-giudice", name: "Danilo Giudice" } },
      });
    }
  });

  test("rejects shortlinks without a LinkedIn post destination", async () => {
    for (const location of [
      null,
      "https://www.linkedin.com/in/example",
      "https://example.com/posts/example-activity-123-test",
      "https://linkedin.com.example.com/feed/update/urn:li:activity:123",
      "not a url",
    ]) {
      const requested: string[] = [];
      await expect(postfetch("https://lnkd.in/p/invalid", {
        fetch: (async (input) => {
          requested.push(String(input));
          return new Response(null, { status: 302, headers: location ? { location } : {} });
        }) as typeof fetch,
      })).rejects.toMatchObject({ status: 400, message: "LinkedIn post id not found" });
      expect(requested).toEqual(["https://lnkd.in/p/invalid"]);
    }
  });

  test("preserves LinkedIn errors when a shortlink cannot be expanded", async () => {
    for (const [status, reason] of [[404, "notFound"], [429, "rateLimited"], [403, "unavailable"]] as const) {
      await expect(postfetch("https://lnkd.in/p/unavailable", {
        fetch: (async (_input: string | URL | Request) => new Response(null, { status, headers: { "retry-after": "0" } })) as typeof fetch,
      })).rejects.toMatchObject({ status, reason });
    }
  });

  test("selects the highest-bitrate MP4 and maps VideoObject metadata", async () => {
    const post = {
      "@context": "https://schema.org",
      "@type": "VideoObject",
      "@id": "https://www.linkedin.com/posts/microsoft-security_watch-the-video-activity-7163247035113013249-ltdX",
      datePublished: "2024-02-13T19:06:19.833Z",
      text: "Watch the video",
      description: "Get guidance on secure remote work with a Zero Trust model.",
      creator: {
        name: "Microsoft Security",
        url: "https://www.linkedin.com/showcase/microsoft-security/",
        interactionStatistic: { interactionType: "http://schema.org/FollowAction", userInteractionCount: 578602 },
      },
      interactionStatistic: [
        { interactionType: "http://schema.org/LikeAction", userInteractionCount: 7 },
        { interactionType: "https://schema.org/CommentAction", userInteractionCount: 2 },
      ],
    };
    const sources = [
      { src: "https://cdn.test/low.mp4?a=1&b=2", type: "video/mp4", "data-bitrate": 90_000 },
      { src: "https://cdn.test/high.mp4?a=1&b=2", type: "video/mp4", "data-bitrate": 1_500_000 },
    ];
    const encodedSources = JSON.stringify(sources).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const html = `<script type="application/ld+json">${JSON.stringify(post)}</script><video data-sources="${encodedSources}"></video>`;
    const requested: string[] = [];

    const result = await postfetch("https://www.linkedin.com/posts/security-share-activity-7163247035113013249-ltdX", {
      fetch: stubPage(html, requested),
    });

    expect(requested).toEqual(["https://www.linkedin.com/feed/update/urn:li:activity:7163247035113013249"]);
    expect(result).toMatchObject({
      id: "7163247035113013249",
      platform: "linkedin",
      items: [{ kind: "video", mime: "video/mp4", url: "https://cdn.test/high.mp4?a=1&b=2" }],
      metadata: {
        title: "Watch the video",
        text: "Get guidance on secure remote work with a Zero Trust model.",
        author: { handle: "microsoft-security", name: "Microsoft Security" },
        createdAt: "2024-02-13T19:06:19.833Z",
        likeCount: 7,
        commentCount: 2,
      },
    });
  });

  test("resolves an image post and canonicalizes a UGC alias to its activity id", async () => {
    const post = {
      "@type": "SocialMediaPosting",
      "@id": "https://www.linkedin.com/posts/linkedin_engineering-activity-7468383643485302784-test",
      datePublished: "2026-07-01T10:20:30.000Z",
      text: "LinkedIn Engineering",
      articleBody: "How we built the platform.",
      author: { name: "LinkedIn", url: "https://www.linkedin.com/company/linkedin" },
      commentCount: 3,
      interactionStatistic: [
        { interactionType: "http://schema.org/LikeAction", userInteractionCount: "42" },
        { interactionType: "http://schema.org/CommentAction", userInteractionCount: 99 },
      ],
      image: { "@type": "ImageObject", url: "https://media.test/NEWImageDrafts3png?token=1" },
    };
    const html = `<script type='application/ld+json'>${JSON.stringify(post)}</script>`;
    const requested: string[] = [];

    const result = await postfetch("https://www.linkedin.com/posts/linkedin_test-ugcPost-7468383642193481729-abcd", {
      fetch: stubPage(html, requested),
    });

    expect(requested).toEqual(["https://www.linkedin.com/feed/update/urn:li:ugcPost:7468383642193481729"]);
    expect(result).toMatchObject({
      id: "7468383643485302784",
      platform: "linkedin",
      items: [{ filename: "linkedin_7468383643485302784.jpg", kind: "image", mime: "image/jpeg" }],
      metadata: {
        title: "LinkedIn Engineering",
        text: "How we built the platform.",
        author: { handle: "linkedin", name: "LinkedIn" },
        commentCount: 3,
        likeCount: 42,
      },
    });
  });

  test("accepts activity, share and ugcPost feed URLs", async () => {
    for (const [kind, id] of [["activity", "1"], ["share", "2"], ["ugcPost", "3"]] as const) {
      const post = {
        "@type": "SocialMediaPosting",
        "@id": `https://www.linkedin.com/feed/update/urn:li:${kind}:${id}`,
        image: "https://media.test/image.jpg",
      };
      const requested: string[] = [];
      await postfetch(`https://uk.linkedin.com/embed/feed/update/urn:li:${kind}:${id}`, {
        fetch: stubPage(`<script type="application/ld+json">${JSON.stringify(post)}</script>`, requested),
      });
      expect(requested).toEqual([`https://www.linkedin.com/feed/update/urn:li:${kind}:${id}`]);
    }
  });

  test("keeps schema text as the caption when no description is present", async () => {
    const post = {
      "@type": "SocialMediaPosting",
      "@id": "https://www.linkedin.com/feed/update/urn:li:activity:4",
      text: "Only schema text",
      image: "https://media.test/image.jpg",
    };

    const result = await postfetch("https://www.linkedin.com/feed/update/urn:li:activity:4", {
      fetch: stubPage(`<script type="application/ld+json">${JSON.stringify(post)}</script>`, []),
    });

    expect(result.metadata).toMatchObject({
      title: "Only schema text",
      text: "Only schema text",
    });
  });
});
