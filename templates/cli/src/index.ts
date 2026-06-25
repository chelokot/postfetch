#!/usr/bin/env bun
import { archive, download, postfetch } from "@postfetch/core";

const url = Bun.argv[2];
if (!url) {
  console.error("usage: postfetch <post-url>");
  process.exit(1);
}

const result = await postfetch(url);
if (result.items.length === 1) {
  const [item] = result.items;
  await Bun.write(item.filename, await download(item));
  console.info(item.filename);
} else {
  const { bytes, filename } = await archive(result);
  await Bun.write(filename, bytes);
  console.info(filename);
}
