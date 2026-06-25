// Every outbound request rotates a fresh, internally-consistent client fingerprint.
// A single hardcoded user-agent / header set is the fastest way to get the whole
// fleet blocked at once, so each component is drawn from a pool and the pieces are
// kept consistent with each other (a Chrome UA always carries a matching Chrome
// `sec-ch-ua` and the right platform token).

function pick<Value>(values: readonly Value[]): Value {
  return values[Math.floor(Math.random() * values.length)] as Value;
}

const chromeVersions = ["128", "129", "130", "131", "132", "133"] as const;
const firefoxVersions = ["140", "143", "146", "148"] as const;

const desktopPlatforms = [
  { chPlatform: "Windows", uaToken: "Windows NT 10.0; Win64; x64" },
  { chPlatform: "macOS", uaToken: "Macintosh; Intel Mac OS X 10_15_7" },
  { chPlatform: "Linux", uaToken: "X11; Linux x86_64" },
] as const;

const acceptLanguages = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en;q=0.9", "en-US,en;q=0.8"] as const;

const instagramAppUserAgents = [
  "Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; onclite; qcom; en_US; 458229237)",
  "Instagram 301.1.0.33.110 Android (34/14; 420dpi; 1080x2340; samsung; SM-G991B; o1s; exynos2100; en_US; 521879118)",
  "Instagram 309.0.0.40.113 Android (33/13; 440dpi; 1080x2280; OnePlus; HD1913; OnePlus7TPro; qcom; en_US; 537291984)",
] as const;

const youtubeClients = [
  { clientVersion: "20.10.38", device: "Pixel 8 Build/AP3A.241105.007", osVersion: "15", sdk: "35" },
  { clientVersion: "19.47.53", device: "SM-S918B Build/UP1A.231005.007", osVersion: "14", sdk: "34" },
  { clientVersion: "19.29.37", device: "Pixel 7 Build/UQ1A.240205.004", osVersion: "14", sdk: "34" },
] as const;

export type BrowserFingerprint = {
  acceptLanguage: string;
  secChUa: string;
  secChUaPlatform: string;
  userAgent: string;
};

export function browserFingerprint(): BrowserFingerprint {
  const version = pick(chromeVersions);
  const platform = pick(desktopPlatforms);
  return {
    acceptLanguage: pick(acceptLanguages),
    secChUa: `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not_A Brand";v="24"`,
    secChUaPlatform: `"${platform.chPlatform}"`,
    userAgent: `Mozilla/5.0 (${platform.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
  };
}

export function navigationHeaders(): Record<string, string> {
  const fingerprint = browserFingerprint();
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": fingerprint.acceptLanguage,
    "sec-ch-ua": fingerprint.secChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": fingerprint.secChUaPlatform,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": fingerprint.userAgent,
  };
}

export function browserUserAgent(): string {
  return browserFingerprint().userAgent;
}

export function firefoxUserAgent(): string {
  const platform = pick(desktopPlatforms);
  const version = pick(firefoxVersions);
  return `Mozilla/5.0 (${platform.uaToken}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
}

export function instagramAppUserAgent(): string {
  return pick(instagramAppUserAgents);
}

export type YoutubeClient = {
  clientVersion: string;
  userAgent: string;
};

export function youtubeClient(): YoutubeClient {
  const client = pick(youtubeClients);
  return {
    clientVersion: client.clientVersion,
    userAgent: `com.google.android.youtube/${client.clientVersion}(Linux; U; Android ${client.osVersion}; en_US; ${client.device}) gzip`,
  };
}
