import { describe, expect, test } from "bun:test";
import { browserFingerprint, browserUserAgent, firefoxUserAgent, navigationHeaders } from "../src/fingerprint";

const platformToken: Record<string, string> = {
  Linux: "Linux x86_64",
  Windows: "Windows NT",
  macOS: "Mac OS X",
};

describe("fingerprint", () => {
  test("browser fingerprints stay internally consistent across rotations", () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const fingerprint = browserFingerprint();
      const uaVersion = fingerprint.userAgent.match(/Chrome\/(\d+)\./)?.[1];
      const hintVersion = fingerprint.secChUa.match(/Google Chrome";v="(\d+)"/)?.[1];
      expect(uaVersion).toBe(hintVersion);
      const platform = fingerprint.secChUaPlatform.replace(/"/g, "");
      expect(fingerprint.userAgent).toContain(platformToken[platform]);
    }
  });

  test("navigationHeaders carry the consistent fingerprint", () => {
    const headers = navigationHeaders();
    expect(headers["sec-fetch-mode"]).toBe("navigate");
    expect(headers["sec-ch-ua"].match(/Google Chrome";v="(\d+)"/)?.[1]).toBe(
      headers["user-agent"].match(/Chrome\/(\d+)\./)?.[1],
    );
  });

  test("browser and firefox user-agents are well-formed distinct families", () => {
    expect(browserUserAgent()).toMatch(/Chrome\/\d+/);
    expect(firefoxUserAgent()).toMatch(/Firefox\/\d+/);
  });
});
