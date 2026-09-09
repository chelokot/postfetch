import { download, type DownloadOptions } from "./download";
import { PostfetchError, type MediaItem } from "./internal";
import { nodeRuntime } from "./mp4-remux";

/** Options for {@link buildAudioSliderVideo}. Requires a local FFmpeg binary. */
export type AudioSliderVideoOptions = DownloadOptions & {
  /** Minimum time per visual item in milliseconds, including its outgoing transition. */
  delay: number;
  /** Output width in pixels; a positive even integer. Defaults to 720. */
  width?: number;
  /** Output height in pixels; a positive even integer. Defaults to 1280. */
  height?: number;
  /** FFmpeg command or executable path. Defaults to `ffmpeg` from PATH. */
  ffmpegPath?: string;
  /** FFprobe command or executable path used to measure audio. Defaults to `ffprobe`. */
  ffprobePath?: string;
};

const fps = 30;

/**
 * Build an H.264/AAC MP4 Blob from one or more images/videos followed by exactly
 * one audio item. Downloads preserve each item's headers and assemble HLS.
 * Visuals retain their aspect ratio, padded with black to the output size.
 * Video clips play from the beginning, looping or trimming to fit; their own
 * audio is discarded. The final audio item plays in full; when the minimum
 * slideshow duration is longer, it loops and is trimmed to the result.
 *
 * Each visual gets at least `delay` ms or audio duration / visual count,
 * whichever is longer (rounded up to 30 fps, minimum two frames). Adjacent
 * visuals slide right to left over the last 300 ms or half the slot, whichever
 * is shorter. The last visual stays on screen; a single visual has no transition.
 * Total duration is the number of visuals times the computed slot duration.
 *
 * Requires Node, Bun or Deno with filesystem/process access, FFprobe and FFmpeg
 * with libx264. Temporary files are removed on success and failure.
 *
 * @example
 * ```ts
 * const result = await postfetch(photoUrl);
 * const blob = await buildAudioSliderVideo(result.items, { delay: 3000 });
 * form.append("video", blob, "slideshow.mp4");
 * ```
 */
export async function buildAudioSliderVideo(
  items: readonly MediaItem[],
  options: AudioSliderVideoOptions,
): Promise<Blob> {
  if (
    !Array.isArray(items) || items.length < 2 || items.at(-1)?.kind !== "audio" ||
    Array.from(items.slice(0, -1)).some((item) => item?.kind !== "image" && item?.kind !== "video")
  ) {
    throw new PostfetchError(400, "Expected one or more image/video items followed by exactly one audio item");
  }
  if (!options || !Number.isFinite(options.delay) || options.delay <= 0) {
    throw new PostfetchError(400, "delay must be a positive finite number of milliseconds");
  }
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  for (const [name, value] of [["width", width], ["height", height]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value % 2 !== 0) {
      throw new PostfetchError(400, `${name} must be a positive even integer`);
    }
  }
  const visuals = items.slice(0, -1);
  const minimumFrames = Math.max(2, Math.ceil(options.delay * fps / 1000));
  if (!Number.isSafeInteger(minimumFrames * visuals.length)) {
    throw new PostfetchError(400, "delay produces an unsupported video duration");
  }
  const io = await nodeRuntime();
  const directory = await io.makeTempDir("postfetch-slider-");
  try {
    // Numbered local paths keep remote filenames out of FFmpeg arguments.
    const paths: string[] = [];
    for (const [index, item] of items.entries()) {
      const path = `${directory}/input-${index}`;
      const response = await download(item, options);
      await io.writeFile(path, new Uint8Array(await response.arrayBuffer()));
      paths.push(path);
    }
    const probe = await io.run(options.ffprobePath ?? "ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries",
      "stream=duration:format=duration", "-of", "json", paths[visuals.length],
    ]);
    if (!probe.success) {
      throw new PostfetchError(500, `Audio slider duration probe failed: ${probe.stderr}`);
    }
    const audioDuration = readAudioDuration(probe.stdout);
    const frames = Math.max(minimumFrames, Math.ceil(audioDuration * fps / visuals.length));
    if (!Number.isSafeInteger(frames * visuals.length)) {
      throw new PostfetchError(500, "Audio slider duration is too large");
    }
    const seconds = frames / fps;
    const transition = Math.min(0.3, seconds / 2);
    const duration = seconds * visuals.length;
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", "1"];
    for (const [index, item] of visuals.entries()) {
      args.push(...(item.kind === "image" ? ["-loop", "1", "-framerate", String(fps)] : ["-stream_loop", "-1"]));
      args.push("-i", paths[index]);
    }
    // If the track sets the duration, play it once and pad only the frame-rounding
    // remainder; do not start the song again for a fraction of a second.
    if (audioDuration < minimumFrames * visuals.length / fps) {
      args.push("-stream_loop", "-1");
    }
    args.push("-i", paths[visuals.length]);
    const filters = visuals.map((_, index) =>
      `[${index}:v:0]setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},` +
      `format=yuv444p,trim=duration=${seconds + (index > 0 ? transition : 0)},setpts=PTS-STARTPTS,fps=${fps},settb=AVTB[v${index}]`,
    );
    let current = "v0";
    for (let index = 1; index < visuals.length; index += 1) {
      const next = `slide${index}`;
      filters.push(`[${current}][v${index}]xfade=transition=slideleft:duration=${transition}:offset=${index * seconds - transition},fps=${fps},settb=AVTB[${next}]`);
      current = next;
    }
    filters.push(`[${current}]format=yuv420p[outv]`);
    filters.push(`[${visuals.length}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}[outa]`);
    const output = `${directory}/slideshow.mp4`;
    args.push(
      "-filter_complex", filters.join(";"), "-map", "[outv]", "-map", "[outa]",
      "-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
    );
    const result = await io.run(options.ffmpegPath ?? "ffmpeg", args);
    if (!result.success) {
      throw new PostfetchError(500, `Audio slider video encoding failed: ${result.stderr}`);
    }
    const bytes = await io.readFile(output);
    if (bytes.length === 0) {
      throw new PostfetchError(500, "Audio slider video encoding produced an empty file");
    }
    return new Blob([new Uint8Array(bytes).buffer], { type: "video/mp4" });
  } finally {
    await io.removeDir(directory).catch(() => undefined);
  }
}

function readAudioDuration(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
    const stream = parsed.streams?.[0];
    const duration = [stream?.duration, parsed.format?.duration]
      .map(Number).find((value) => Number.isFinite(value) && value > 0);
    if (stream && duration !== undefined) return duration;
  } catch {
    // Missing, malformed or non-finite metadata cannot guarantee a complete track.
  }
  throw new PostfetchError(500, "Audio slider audio duration is unavailable");
}
