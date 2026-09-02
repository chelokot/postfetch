import { PostfetchError, postfetch, toResponse } from "@postfetch/core";

const port = Number(Bun.env.PORT ?? 3040);

Bun.serve({
  idleTimeout: 120,
  port,
  async fetch(request) {
    try {
      const { url, preferredWidth, tryMaxBytes } = await readInput(request);
      const result = await postfetch(url, { preferredWidth, tryMaxBytes });
      return await toResponse(result);
    } catch (error) {
      const status = error instanceof PostfetchError ? error.status : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      return new Response(`${message}\n`, { headers: { "content-type": "text/plain; charset=utf-8" }, status });
    }
  },
});

console.info(`http://localhost:${port}/?url=`);

async function readInput(request: Request): Promise<{ preferredWidth?: number; tryMaxBytes?: number; url: string }> {
  const requestUrl = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const raw = requestUrl.searchParams.get("url") ?? body;
  if (!raw || raw.trim().length === 0) {
    throw new PostfetchError(400, "pass ?url= or POST a URL");
  }
  return {
    preferredWidth: positiveInt(requestUrl.searchParams.get("width")),
    tryMaxBytes: positiveInt(requestUrl.searchParams.get("tryMaxBytes")),
    url: raw.trim(),
  };
}

function positiveInt(value: string | null): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
