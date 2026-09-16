#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const limits: ReadonlyArray<readonly [string, number, number]> = [
  // Phase-1 workspace shell/geometry adapter: base 331067/81296; measured 347016/85246.
  ["public/app.bundle.js", 350_000, 87_000],
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
