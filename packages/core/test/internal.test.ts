import { describe, expect, test } from "bun:test";
import { asUrl, bool, count, filename, isoFromDateString, isoFromEpochSeconds } from "../src/internal";

describe("core helpers", () => {
  test("normalizes filenames for content-disposition", () => {
    expect(filename("youtube: hello/world?.mp4")).toBe("youtube_hello_world_.mp4");
  });

  test("rejects invalid URLs", () => {
    expect(() => asUrl("not a url")).toThrow("invalid url");
  });
});

describe("metadata coercion", () => {
  test("count accepts non-negative integers and numeric strings", () => {
    expect(count(9969)).toBe(9969);
    expect(count("397116984")).toBe(397116984);
    expect(count(0)).toBe(0);
  });

  test("count rejects negatives, floats, non-numeric and missing values", () => {
    expect(count(-1)).toBeUndefined();
    expect(count(1.5)).toBeUndefined();
    expect(count("12a")).toBeUndefined();
    expect(count(null)).toBeUndefined();
    expect(count(undefined)).toBeUndefined();
  });

  test("bool passes booleans through and drops everything else", () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool("true")).toBeUndefined();
    expect(bool(undefined)).toBeUndefined();
  });

  test("isoFromEpochSeconds converts epoch seconds, as number or string", () => {
    expect(isoFromEpochSeconds(1782557495)).toBe("2026-06-27T10:51:35.000Z");
    expect(isoFromEpochSeconds("1782557495")).toBe("2026-06-27T10:51:35.000Z");
    expect(isoFromEpochSeconds("nope")).toBeUndefined();
  });

  test("isoFromDateString normalizes ISO and RFC 2822 dates", () => {
    expect(isoFromDateString("2026-03-19T11:49:12.000Z")).toBe("2026-03-19T11:49:12.000Z");
    expect(isoFromDateString("Mon, 20 Oct 2025 03:08:47 +0000")).toBe("2025-10-20T03:08:47.000Z");
    expect(isoFromDateString("not a date")).toBeUndefined();
    expect(isoFromDateString(42)).toBeUndefined();
  });
});
