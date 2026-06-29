import { describe, expect, test } from "bun:test";
import { isShortlinkHost } from "../src/tiktok";

describe("tiktok url parsing", () => {
  test("treats vm and vt hosts as shortlinks to follow", () => {
    expect(isShortlinkHost("vm.tiktok.com")).toBe(true);
    expect(isShortlinkHost("vt.tiktok.com")).toBe(true);
  });

  test("leaves canonical hosts untouched", () => {
    expect(isShortlinkHost("www.tiktok.com")).toBe(false);
    expect(isShortlinkHost("m.tiktok.com")).toBe(false);
  });
});
