#!/usr/bin/env bun
import { archive, download, postfetch, PostfetchError } from "@postfetch/core";

const args = Bun.argv.slice(2);
let url: string | undefined;
let outDir = ".";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-o" || arg === "--out") {
    outDir = args[index + 1] ?? ".";
    index += 1;
  } else if (!url) {
    url = arg;
  }
}

if (!url) {
  console.error("usage: postfetch <post-url> [-o <dir>]");
  process.exit(2);
}

try {
  const result = await postfetch(url);
  if (result.items.length === 1) {
    const [item] = result.items;
    const path = `${outDir}/${item.filename}`;
    await Bun.write(path, await download(item));
    console.info(path);
  } else {
    const { bytes, filename } = await archive(result);
    const path = `${outDir}/${filename}`;
    await Bun.write(path, bytes);
    console.info(path);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`postfetch: ${message}`);
  process.exit(error instanceof PostfetchError && error.status < 500 ? 1 : 70);
}
