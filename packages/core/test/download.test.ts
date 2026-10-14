import { describe, expect, test } from "bun:test";
import { archive, download, downloadBlob, type MediaItem } from "../src/index";

const item: MediaItem = {
  url: "https://cdn.test/image.jpg", headers: { "x-media": "required" },
  filename: "image.jpg", id: "x", kind: "image", mime: "image/jpeg", platform: "twitter",
};
const interrupted = new TypeError("error reading a body from connection");

function brokenResponse(): Response {
  let pulls = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Uint8Array.of(99));
      else controller.error(interrupted);
    },
  }));
}

describe("buffered download retries", () => {
  for (const input of [item.url, item]) {
    test(`restarts an interrupted ${typeof input === "string" ? "URL" : "media item"} Blob without keeping partial bytes`, async () => {
      let calls = 0;
      const signals: (AbortSignal | null | undefined)[] = [];
      const fetch = (async (_input, init) => {
        expect(new Headers(init?.headers).get("x-media")).toBe("required");
        signals.push(init?.signal);
        if (++calls === 1) return brokenResponse();
        return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/jpeg" } });
      }) as typeof globalThis.fetch;
      const blob = await downloadBlob(input, { fetch, headers: item.headers });
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
      expect(blob.type).toBe("image/jpeg");
      expect(calls).toBe(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).not.toBe(signals[0]);
    });
  }

  test("retries archive body reads", async () => {
    let calls = 0;
    const fetch = (async (_input: string | URL | Request) => ++calls === 1 ? brokenResponse() : new Response(Uint8Array.of(1, 2, 3))) as typeof globalThis.fetch;
    const result = await archive({ platform: "twitter", id: "x", comments: [], items: [item], archiveFilename: "x.zip" }, { fetch });
    // The local ZIP entry contains only the successful transfer's payload.
    const view = new DataView(result.bytes.buffer);
    const offset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    expect(result.bytes.subarray(offset, offset + 3)).toEqual(Uint8Array.of(1, 2, 3));
    expect(view.getUint32(18, true)).toBe(3);
    expect(calls).toBe(2);
  });

  test("stops after three interrupted bodies and preserves the last error", async () => {
    let calls = 0;
    const fetch = (async (_input: string | URL | Request) => { calls++; return brokenResponse(); }) as typeof globalThis.fetch;
    await expect(downloadBlob(item, { fetch })).rejects.toBe(interrupted);
    expect(calls).toBe(3);
  });

  for (const [status, attempts] of [[403, 1], [503, 3]]) {
    test(`does not add body retries to HTTP ${status}`, async () => {
      let calls = 0;
      const fetch = (async (_input: string | URL | Request) => { calls++; return new Response("unavailable", { status }); }) as typeof globalThis.fetch;
      await expect(downloadBlob(item, { fetch })).rejects.toMatchObject({ status: 502, message: `download failed: ${status}` });
      expect(calls).toBe(attempts);
    });
  }

  test("does not retry an empty response with no body", async () => {
    let calls = 0;
    const fetch = (async (_input: string | URL | Request) => { calls++; return new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
    await expect(downloadBlob(item, { fetch })).rejects.toMatchObject({ status: 502, message: "download failed: 204" });
    expect(calls).toBe(1);
  });

  test("does not restart exhausted connection retries", async () => {
    let calls = 0;
    const fetch = (async (_input: string | URL | Request): Promise<Response> => { calls++; throw interrupted; }) as typeof globalThis.fetch;
    await expect(downloadBlob(item, { fetch })).rejects.toBe(interrupted);
    expect(calls).toBe(3);
  });

  test("keeps plain download responses streaming", async () => {
    let calls = 0;
    const fetch = (async (_input: string | URL | Request) => { calls++; return brokenResponse(); }) as typeof globalThis.fetch;
    const response = await download(item, { fetch });
    await expect(response.arrayBuffer()).rejects.toBe(interrupted);
    expect(calls).toBe(1);
  });
});
