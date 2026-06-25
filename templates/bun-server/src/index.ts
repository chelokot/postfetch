import { PostfetchError, postfetch, toResponse } from "@postfetch/core";

const port = Number(Bun.env.PORT ?? 3040);

Bun.serve({
  port,
  async fetch(request) {
    try {
      const url = new URL(request.url).searchParams.get("url");
      if (!url) {
        throw new PostfetchError(400, "pass ?url=");
      }
      return await toResponse(await postfetch(url));
    } catch (error) {
      const status = error instanceof PostfetchError ? error.status : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      return new Response(`${message}\n`, { status });
    }
  },
});

console.info(`http://localhost:${port}/?url=`);
