import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { PostfetchError, archive, download, postfetch } from "@postfetch/core";

app.http("postfetch", {
  authLevel: "anonymous",
  methods: ["GET", "POST"],
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const url = (request.query.get("url") ?? (await request.text())).trim();
      const result = await postfetch(url);
      if (result.items.length === 1) {
        const [item] = result.items;
        const response = await download(item);
        const body = new Uint8Array(await response.arrayBuffer());
        return { body, headers: { "content-disposition": `attachment; filename="${item.filename}"`, "content-type": item.mime } };
      }
      const { bytes, filename, mime } = await archive(result);
      return { body: bytes, headers: { "content-disposition": `attachment; filename="${filename}"`, "content-type": mime } };
    } catch (error) {
      const status = error instanceof PostfetchError ? error.status : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      return { body: message, headers: { "content-type": "text/plain; charset=utf-8" }, status };
    }
  },
});
