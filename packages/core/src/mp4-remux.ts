type CommandResult = {
  stderr: string;
  stdout: string;
  success: boolean;
};

export type PreparedMp4 = {
  bytes: Uint8Array;
  duration: number;
  height: number;
  thumbnail: Uint8Array;
  width: number;
};

export type Mp4RemuxRuntime = {
  makeTempDir(prefix: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  removeDir(path: string): Promise<void>;
  run(command: string, args: string[]): Promise<CommandResult>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
};

/**
 * Normalize an MP4, extract a Telegram-compatible JPEG thumbnail, and calculate
 * the presentation dimensions and duration. Encoded media is left untouched;
 * FFmpeg only rebuilds the container and timing tables.
 */
export async function prepareMp4(
  bytes: Uint8Array,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  runtime?: Mp4RemuxRuntime,
): Promise<PreparedMp4 | null> {
  let directory: string | undefined;
  let io: Mp4RemuxRuntime | undefined;
  try {
    io = runtime ?? (await nodeRuntime());
    directory = await io.makeTempDir("postfetch-remux-");
    const inputPath = `${directory}/input.mp4`;
    const outputPath = `${directory}/output.mp4`;
    await io.writeFile(inputPath, bytes);
    const result = await io.run(ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      "-use_editlist",
      "0",
      outputPath,
    ]);
    if (!result.success) {
      return null;
    }
    const output = await io.readFile(outputPath);
    if (output.length === 0) {
      return null;
    }
    const thumbnailPath = `${directory}/thumbnail.jpg`;
    const thumbnailResult = await io.run(ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      outputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=320:320:force_original_aspect_ratio=decrease",
      "-c:v",
      "mjpeg",
      "-q:v",
      "5",
      thumbnailPath,
    ]);
    if (!thumbnailResult.success) {
      return null;
    }
    const thumbnail = await io.readFile(thumbnailPath);
    if (!validThumbnail(thumbnail)) {
      return null;
    }
    const probe = await io.run(ffprobePath, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      outputPath,
    ]);
    if (!probe.success) {
      return null;
    }
    const metadata = parseVideoMetadata(probe.stdout);
    return metadata ? { bytes: output, thumbnail, ...metadata } : null;
  } catch {
    return null;
  } finally {
    if (directory && io) {
      await io.removeDir(directory).catch(() => undefined);
    }
  }
}

function validThumbnail(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes.length < 200_000 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function parseVideoMetadata(value: string): Pick<PreparedMp4, "duration" | "height" | "width"> | null {
  const parsed = JSON.parse(value) as {
    format?: { duration?: string };
    streams?: Array<{
      duration?: string;
      height?: number;
      side_data_list?: Array<{ rotation?: number }>;
      width?: number;
    }>;
  };
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration ?? stream?.duration);
  const width = stream?.width ?? 0;
  const height = stream?.height ?? 0;
  if (!stream || !(duration > 0 && Number.isFinite(duration) && width > 0 && height > 0)) {
    return null;
  }
  const rotation = stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    duration: Math.ceil(duration),
    height: sideways ? width : height,
    width: sideways ? height : width,
  };
}

// Deno, Bun and Node all expose the Node compatibility modules used here. They
// stay behind dynamic imports so browser/edge consumers that leave remux off do
// not load or execute any process/filesystem code.
async function nodeRuntime(): Promise<Mp4RemuxRuntime> {
  const [{ spawn }, { mkdtemp, readFile, rm, writeFile }, { tmpdir }, { join }] = await Promise.all([
    import("node:child_process"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return {
    makeTempDir: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    removeDir: async (path) => {
      await rm(path, { force: true, recursive: true });
    },
    run: (command, args) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        let stdout = "";
        child.stdout?.on("data", (chunk: Uint8Array) => {
          stdout += new TextDecoder().decode(chunk);
        });
        child.stderr?.on("data", (chunk: Uint8Array) => {
          if (stderr.length < 4096) {
            stderr += new TextDecoder().decode(chunk).slice(0, 4096 - stderr.length);
          }
        });
        child.once("error", (error) => resolve({ stderr: error.message, stdout, success: false }));
        child.once("close", (code) => resolve({ stderr, stdout, success: code === 0 }));
      }),
    writeFile: async (path, value) => {
      await writeFile(path, value);
    },
  };
}
