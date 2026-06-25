import { PostfetchError, postfetch, toResponse } from "@postfetch/core";

export default {
  async fetch(request: Request): Promise<Response> {
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
};
