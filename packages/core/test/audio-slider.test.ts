import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioSliderVideo, type MediaItem } from "../src/index";

function item(kind: MediaItem["kind"], name: string = kind): MediaItem {
  return { kind, url: `https://cdn.test/${name}`, headers: { "x-media": name }, filename: name, id: "slider", platform: "tiktok", mime: `${kind}/test` };
}

describe("audio slider validation", () => {
  const image = item("image");
  const video = item("video");
  const audio = item("audio");
  const fetch = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("validation must run before downloading"); }) as typeof globalThis.fetch;

  test("requires visual items followed by exactly one audio item", async () => {
    for (const items of [[], [audio], [image], [image, video], [audio, image], [image, audio, audio], [image, audio, video, audio]]) {
      await expect(buildAudioSliderVideo(items, { delay: 1000, fetch })).rejects.toThrow("followed by exactly one audio");
    }
  });

  test("rejects invalid timing and dimensions before downloading", async () => {
    for (const delay of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
      await expect(buildAudioSliderVideo([image, audio], { delay, fetch })).rejects.toThrow("delay");
    }
    for (const size of [0, -2, 3, 2.5, NaN, Infinity]) {
      for (const key of ["width", "height"]) {
        await expect(buildAudioSliderVideo([image, audio], { delay: 1000, [key]: size, fetch })).rejects.toThrow(`${key} must be a positive even integer`);
      }
    }
  });
});

const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const hasFfmpeg = encoders.status === 0 && encoders.stdout.includes("libx264") && spawnSync("ffprobe", ["-version"]).status === 0;
describe.skipIf(!hasFfmpeg)("audio slider encoding (local FFmpeg)", () => {
  let directory: string;
  const media = new Map<string, Uint8Array>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const name = String(input).split("/").at(-1)!;
    expect(new Headers(init?.headers).get("x-media")).toBe(name);
    const bytes = media.get(name);
    return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;

  function ffmpeg(args: string[]): Buffer {
    return execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 4 * 1024 * 1024 });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "postfetch-slider-test-"));
    ffmpeg(["-f", "lavfi", "-i", "color=red:s=160x120", "-frames:v", "1", `${directory}/red.png`]);
    ffmpeg(["-f", "lavfi", "-i", "color=lime:s=120x160", "-frames:v", "1", `${directory}/green.png`]);
    ffmpeg(["-f", "lavfi", "-i", "color=blue:s=240x240:r=24:d=0.25", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.25", "-c:v", "libx264", "-c:a", "aac", "-shortest", `${directory}/blue.mp4`]);
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", `${directory}/sound.wav`]);
    for (const name of ["red.png", "green.png", "blue.mp4", "sound.wav"]) {
      media.set(name, new Uint8Array(await readFile(`${directory}/${name}`)));
    }
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  async function encode(visuals: MediaItem[], name: string): Promise<string> {
    const blob = await buildAudioSliderVideo([...visuals, item("audio", "sound.wav")], { delay: 1000, width: 160, height: 160, fetch });
    expect(blob.type).toBe("video/mp4");
    const path = `${directory}/${name}.mp4`;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }

  function probe(path: string) {
    return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
  }

  function frame(path: string, time: number): Buffer {
    return ffmpeg(["-ss", String(time), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  }

  function pixel(frame: Buffer, x: number, y = 80): number[] {
    return [...frame.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
  }

  test("encodes mixed media in order, slides left, and loops only the soundtrack", async () => {
    const path = await encode([item("image", "red.png"), item("video", "blue.mp4"), item("image", "green.png")], "mixed");
    const metadata = probe(path);
    expect(Number(metadata.format.duration)).toBeCloseTo(3, 1);
    expect(metadata.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual(["h264", "aac"]);
    expect(metadata.streams[0]).toMatchObject({ width: 160, height: 160, pix_fmt: "yuv420p", r_frame_rate: "30/1" });
    expect(pixel(frame(path, 0.3), 80)[0]).toBeGreaterThan(220);
    const sliding = frame(path, 0.85);
    expect(pixel(sliding, 20)[0]).toBeGreaterThan(220); // outgoing red moved left
    expect(pixel(sliding, 140)[2]).toBeGreaterThan(220); // incoming blue arrived from right
    expect(pixel(frame(path, 1.5), 80)[2]).toBeGreaterThan(220); // short clip looped
    expect(pixel(frame(path, 2.8), 80)[1]).toBeGreaterThan(220);
    expect(pixel(frame(path, 0.3), 80, 0)).toEqual([0, 0, 0]); // aspect ratio retained

    // Sample well beyond the 0.2 s soundtrack, during the video and last image.
    // 440 Hz verifies soundtrack looping and excludes the video's 880 Hz audio.
    for (const time of [1.3, 2.6]) {
      const pcm = ffmpeg(["-ss", String(time), "-i", path, "-t", "0.1", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
      let energy = 0;
      let crossings = 0;
      for (let offset = 4; offset < pcm.length; offset += 4) {
        const value = pcm.readFloatLE(offset);
        energy += value * value;
        if (pcm.readFloatLE(offset - 4) <= 0 && value > 0) crossings += 1;
      }
      expect(energy / (pcm.length / 4)).toBeGreaterThan(0.001);
      expect(crossings).toBeGreaterThan(40);
      expect(crossings).toBeLessThan(48);
    }
  }, 30000);

  test("supports one visual with audio and no transition", async () => {
    const path = await encode([item("image", "red.png")], "single");
    const metadata = probe(path);
    expect(Number(metadata.format.duration)).toBeCloseTo(1, 1);
    expect(Number(metadata.streams[1].duration)).toBeCloseTo(1, 1);
    expect(pixel(frame(path, 0.8), 80)[0]).toBeGreaterThan(220);
  }, 15000);

  test("rounds small and fractional delays to frames without losing visuals", async () => {
    for (const delay of [1, 250.5]) {
      const blob = await buildAudioSliderVideo([item("image", "red.png"), item("image", "green.png"), item("audio", "sound.wav")], { delay, width: 160, height: 160, fetch });
      const path = `${directory}/delay-${delay}.mp4`;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      const metadata = probe(path);
      const frames = Math.max(2, Math.round(delay * 30 / 1000));
      expect(Number(metadata.streams[0].nb_frames)).toBe(frames * 2);
      expect(pixel(frame(path, 0), 80)[0]).toBeGreaterThan(220);
      expect(pixel(frame(path, (frames * 2 - 1) / 30), 80)[1]).toBeGreaterThan(220);
    }
  }, 15000);

  test("reports download/encoding failures and removes temporary files", async () => {
    const before = new Set(await readdir(tmpdir()));
    const items = [item("image", "red.png"), item("audio", "sound.wav")];
    await expect(buildAudioSliderVideo(items, { delay: 1000, fetch, ffmpegPath: "postfetch-missing-ffmpeg-test" })).rejects.toThrow("Audio slider video encoding failed");
    await expect(buildAudioSliderVideo([item("image", "missing"), items[1]], { delay: 1000, fetch })).rejects.toThrow("404");
    media.set("corrupt", new TextEncoder().encode("broken media"));
    await expect(buildAudioSliderVideo([item("video", "corrupt"), items[1]], { delay: 1000, fetch })).rejects.toThrow("Audio slider video encoding failed");
    const leaked = (await readdir(tmpdir())).filter((name) => name.startsWith("postfetch-slider-") && !before.has(name));
    expect(leaked).toEqual([]);
  }, 15000);
});
