import { describe, expect, test } from "bun:test";
import { instagramUnavailableReason } from "../src/instagram";

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
