type Case = {
  contentType: string;
  count: number;
  kind?: string;
  minBytes: number;
  name: string;
  platform: string;
  url: string;
  zipEntries?: number;
};

const baseUrl = process.env.POSTFETCH_E2E_BASE_URL ?? "http://127.0.0.1:3040";
const selectedPlatforms = platforms();
const cases: Case[] = [
  {
    contentType: "video/mp4",
    count: 1,
    kind: "video",
    minBytes: 1_000_000,
    name: "tiktok video shortlink",
    platform: "tiktok",
    url: "https://vt.tiktok.com/ZSxpHvCUM/",
  },
  {
    contentType: "application/zip",
    count: 10,
    minBytes: 500_000,
    name: "tiktok slideshow",
    platform: "tiktok",
    url: "https://www.tiktok.com/@matryoshk4/video/7231234675476532526",
    zipEntries: 10,
  },
  {
    contentType: "video/mp4",
    count: 1,
    kind: "video",
    minBytes: 1_000_000,
    name: "instagram reel",
    platform: "instagram",
    url: "https://www.instagram.com/reel/DNoW_6xygMC/",
  },
  {
    contentType: "application/zip",
    count: 10,
    minBytes: 1_000_000,
    name: "instagram carousel",
    platform: "instagram",
    url: "https://www.instagram.com/p/CvYrSgnsKjv/",
    zipEntries: 10,
  },
  {
    contentType: "video/mp4",
    count: 1,
    kind: "video",
    minBytes: 1_000_000,
    name: "youtube shorts",
    platform: "youtube",
    url: "https://www.youtube.com/shorts/r5FpeOJItbw",
  },
  {
    contentType: "video/mp4",
    count: 1,
    kind: "video",
    minBytes: 1_000_000,
    name: "youtube watch",
    platform: "youtube",
    url: "https://www.youtube.com/watch?v=r5FpeOJItbw",
  },
].filter((item) => selectedPlatforms.has(item.platform));

assert(cases.length > 0, `no e2e cases selected for ${[...selectedPlatforms].join(", ")}`);

await waitForServer();

for (const item of cases) {
  await retry(item.name, () => check(item));
}

async function check(testCase: Case): Promise<void> {
  const url = new URL(baseUrl);
  url.searchParams.set("url", testCase.url);
  const response = await fetch(url);
  const body = new Uint8Array(await response.arrayBuffer());

  assert(response.status === 200, `${testCase.name}: expected 200, got ${response.status}: ${new TextDecoder().decode(body)}`);
  assert(body.length >= testCase.minBytes, `${testCase.name}: expected at least ${testCase.minBytes} bytes, got ${body.length}`);
  assertHeader(response, "content-type", testCase.contentType);
  assertHeader(response, "x-media-platform", testCase.platform);
  assertHeader(response, "x-media-count", String(testCase.count));
  if (testCase.kind) {
    assertHeader(response, "x-media-kind", testCase.kind);
  }
  if (testCase.contentType === "video/mp4") {
    assert(isMp4(body), `${testCase.name}: response is not an mp4`);
  }
  if (testCase.contentType === "application/zip") {
    assert(zipEntryCount(body) === testCase.zipEntries, `${testCase.name}: expected ${testCase.zipEntries} zip entries`);
  }
  console.info(`${testCase.name}: ok ${body.length} bytes`);
}

async function waitForServer(): Promise<void> {
  await retry("server readiness", async () => {
    const response = await fetch(baseUrl);
    assert(response.status === 400, `expected readiness status 400, got ${response.status}`);
  }, 20, 500);
}

async function retry(name: string, action: () => Promise<void>, attempts = 3, delay = 2_000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${name} failed`);
}

function assertHeader(response: Response, name: string, expected: string): void {
  const actual = response.headers.get(name);
  assert(actual?.startsWith(expected), `${name}: expected ${expected}, got ${actual}`);
}

function isMp4(body: Uint8Array): boolean {
  return body.length > 12 && String.fromCharCode(...body.slice(4, 8)) === "ftyp";
}

function zipEntryCount(body: Uint8Array): number {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = body.length - 22; offset >= Math.max(0, body.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return view.getUint16(offset + 10, true);
    }
  }
  throw new Error("zip end-of-central-directory not found");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function platforms(): Set<string> {
  const argument = Bun.argv.find((item) => item.startsWith("--platform="));
  if (!argument) {
    return new Set(["instagram", "tiktok", "youtube"]);
  }
  const values = argument
    .slice("--platform=".length)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(values);
}

export {};
