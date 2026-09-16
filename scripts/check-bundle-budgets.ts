#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const limits: ReadonlyArray<readonly [string, number, number]> = [
  // Phase-2 extension host: approved base 349590/85735; reviewed 385409/94531.
  // Explicit A2 allowance; CSS, Ghostty and timing caps are unchanged.
  ["public/app.bundle.js", 386_000, 95_000],
  ["public/ghostty-web.bundle.js", 700_000, 210_000],
  // Phase-1 shell controls/full-view recovery: base 96978/17005; measured 100603/17595.
  ["public/styles.css", 102_000, 20_000],
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
