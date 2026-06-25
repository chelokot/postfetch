import { PostfetchError, archive, download, postfetch } from "@postfetch/core";

type LambdaEvent = {
  body?: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
};

type LambdaResult = {
  body: string;
  headers: Record<string, string>;
  isBase64Encoded: boolean;
  statusCode: number;
};

export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  try {
    const url = (event.queryStringParameters?.url ?? event.body ?? "").trim();
    const result = await postfetch(url);
    if (result.items.length === 1) {
      const [item] = result.items;
      const response = await download(item);
      return binary(new Uint8Array(await response.arrayBuffer()), item.mime, item.filename);
    }
    const { bytes, filename, mime } = await archive(result);
    return binary(bytes, mime, filename);
  } catch (error) {
    const status = error instanceof PostfetchError ? error.status : 500;
    const message = error instanceof Error ? error.message : "unknown error";
    return { body: message, headers: { "content-type": "text/plain; charset=utf-8" }, isBase64Encoded: false, statusCode: status };
  }
}

function binary(bytes: Uint8Array, mime: string, name: string): LambdaResult {
  return {
    body: Buffer.from(bytes).toString("base64"),
    headers: { "content-disposition": `attachment; filename="${name}"`, "content-type": mime },
    isBase64Encoded: true,
    statusCode: 200,
  };
}
