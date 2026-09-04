type CommandResult = {
  stderr: string;
  success: boolean;
};

export type Mp4RemuxRuntime = {
  makeTempDir(prefix: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  removeDir(path: string): Promise<void>;
  run(command: string, args: string[]): Promise<CommandResult>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
};

/**
 * Normalize an MP4 with the same stream-copy remux used by UMMR. Encoded media
 * is left untouched; FFmpeg only rebuilds the container and timing tables.
 * Returns `null` when FFmpeg is unavailable or the input cannot be remuxed.
 */
export async function remuxMp4(
  bytes: Uint8Array,
  ffmpegPath = "ffmpeg",
  runtime?: Mp4RemuxRuntime,
): Promise<Uint8Array | null> {
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
    return output.length > 0 ? output : null;
  } catch {
    return null;
  } finally {
    if (directory && io) {
      await io.removeDir(directory).catch(() => undefined);
    }
  }
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
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Uint8Array) => {
          if (stderr.length < 4096) {
            stderr += new TextDecoder().decode(chunk).slice(0, 4096 - stderr.length);
          }
        });
        child.once("error", (error) => resolve({ stderr: error.message, success: false }));
        child.once("close", (code) => resolve({ stderr, success: code === 0 }));
      }),
    writeFile: async (path, value) => {
      await writeFile(path, value);
    },
  };
}
