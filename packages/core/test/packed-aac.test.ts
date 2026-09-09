import { describe, expect, test } from "bun:test";
import { packedAacToMp4 } from "../src/packed-aac";
import { assembleHls } from "../src/hls";
import { childBoxes, concat, findBox, parseBoxes, readU32, type Box } from "../src/isobmff";
import { createNet } from "../src/internal";

function frame(payload: number[], frequencyIndex = 4, crc = false): Uint8Array {
  const size = payload.length + (crc ? 9 : 7);
  return Uint8Array.of(0xff, crc ? 0xf0 : 0xf1, 0x40 | (frequencyIndex << 2), 0x80 | (size >> 11),
    (size >> 3) & 255, ((size & 7) << 5) | 31, 0xfc, ...(crc ? [0, 0] : []), ...payload);
}

function timestampTag(timestamp: number, version = 3): Uint8Array {
  const owner = new TextEncoder().encode("com.apple.streaming.transportStreamTimestamp\0");
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, BigInt(timestamp));
  const tagSize = 10 + owner.length + value.length;
  return concat([
    Uint8Array.of(73, 68, 51, version, 0, 0, 0, 0, 0, tagSize),
    Uint8Array.of(80, 82, 73, 86, 0, 0, 0, owner.length + value.length, 0, 0),
    owner, value,
  ]);
}

function required(box: Box | undefined): Box {
  if (!box) throw new Error("Missing box");
  return box;
}

function timestamps(bytes: Uint8Array): number[] {
  return parseBoxes(bytes).filter((box) => box.type === "moof").map((moof) => {
    const traf = required(findBox(childBoxes(bytes, moof), "traf"));
    const tfdt = required(findBox(childBoxes(bytes, traf), "tfdt"));
    return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(tfdt.dataStart + 4));
  });
}

describe("packed AAC", () => {
  test("leaves non-AAC segments alone", () => {
    expect(packedAacToMp4([Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112)])).toBeNull();
    expect(packedAacToMp4([])).toBeNull();
  });

  test("preserves AAC payloads and uses ID3 timestamps for A/V alignment", () => {
    const bytes = packedAacToMp4([
      concat([timestampTag(90000), frame([1, 2, 3]), frame([4, 5])]),
      concat([timestampTag(180000, 4), frame([6, 7, 8], 4, true)]),
    ])!;
    const boxes = parseBoxes(bytes);
    expect(boxes.map((box) => box.type)).toEqual(["ftyp", "moov", "moof", "mdat", "moof", "mdat"]);
    expect(boxes.filter((box) => box.type === "mdat").map((box) => [...bytes.subarray(box.dataStart, box.end)]))
      .toEqual([[1, 2, 3, 4, 5], [6, 7, 8]]);
    expect(timestamps(bytes)).toEqual([44100, 88200]);
    for (const moof of boxes.filter((box) => box.type === "moof")) {
      const traf = required(findBox(childBoxes(bytes, moof), "traf"));
      const trun = required(findBox(childBoxes(bytes, traf), "trun"));
      expect(readU32(bytes, trun.dataStart + 8)).toBe(moof.end - moof.start + 8);
    }
  });

  test("continues sample timing when a segment has no timestamp", () => {
    const bytes = packedAacToMp4([frame([1]), frame([2])])!;
    expect(timestamps(bytes)).toEqual([0, 1024]);
  });

  test("rejects truncated frames and metadata", () => {
    expect(() => packedAacToMp4([frame([1, 2, 3]).slice(0, -1)])).toThrow("Truncated packed AAC");
    expect(() => packedAacToMp4([timestampTag(0).slice(0, -1)])).toThrow("Truncated packed AAC ID3");
    expect(() => packedAacToMp4([timestampTag(0)])).toThrow("no audio frames");
  });

  test("rejects codec changes and unsupported profiles instead of corrupting audio", () => {
    expect(() => packedAacToMp4([frame([1]), frame([2], 3)])).toThrow("configuration changed");
    const unsupported = frame([1]);
    unsupported[2] &= 0x3f; // AAC Main rather than AAC-LC
    expect(() => packedAacToMp4([unsupported])).toThrow("Unsupported packed AAC");
  });

  test("HLS assembly packages packed AAC into a fragmented MP4", async () => {
    const audio = concat([timestampTag(0), frame([1, 2, 3])]);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-audio")).toBe("required");
      return String(input).endsWith(".m3u8")
        ? new Response("#EXTM3U\n#EXTINF:1,\naudio.aac\n#EXT-X-ENDLIST")
        : new Response(new Uint8Array(audio));
    }) as typeof globalThis.fetch;
    const bytes = await assembleHls(createNet(fetch), "https://cdn.test/audio.m3u8", { "x-audio": "required" });
    expect(parseBoxes(bytes).map((box) => box.type)).toEqual(["ftyp", "moov", "moof", "mdat"]);
  });
});
