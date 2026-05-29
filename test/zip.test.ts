import { describe, expect, test } from "bun:test";
import { zip } from "../src/zip";

const decoder = new TextDecoder();

describe("zip", () => {
  test("creates a store-mode zip with central directory entries", () => {
    const archive = zip([
      { data: new TextEncoder().encode("hello"), name: "one.txt" },
      { data: new TextEncoder().encode("world"), name: "nested/two.txt" },
    ]);
    const view = new DataView(archive.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    const endOffset = archive.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 10, true)).toBe(2);

    const centralOffset = view.getUint32(endOffset + 16, true);
    const firstNameLength = view.getUint16(centralOffset + 28, true);
    const firstName = archive.slice(centralOffset + 46, centralOffset + 46 + firstNameLength);
    expect(decoder.decode(firstName)).toBe("one.txt");
  });
});
