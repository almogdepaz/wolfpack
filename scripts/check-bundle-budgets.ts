#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const limits: ReadonlyArray<readonly [string, number, number]> = [
  ["public/app.bundle.js", 300_000, 85_000],
  ["public/ghostty-web.bundle.js", 700_000, 210_000],
  ["public/styles.css", 100_000, 20_000],
];
let failed = false;
for (const [file, rawLimit, gzipLimit] of limits) {
  const bytes = readFileSync(join(root, file));
  const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
  console.log(`${file}: ${bytes.byteLength} raw, ${gzipBytes} gzip`);
  if (bytes.byteLength > rawLimit || gzipBytes > gzipLimit) {
    console.error(`budget exceeded: ${file} (limits ${rawLimit} raw / ${gzipLimit} gzip)`);
    failed = true;
  }
}
if (failed) process.exit(1);
