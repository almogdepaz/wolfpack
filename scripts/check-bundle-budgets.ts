#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const limits: ReadonlyArray<readonly [string, number, number]> = [
  // Phase-2 extension host: approved base 349590/85735; reviewed 385409/94531.
  // Selected-machine extensions + current main: approved gzip cap 97000; measured 96008.
  // OSC 7501 program status + current main: approved gzip cap 97500; measured 97087.
  // One-tap notifications + peer relay ui: approved gzip cap 98000; measured 97793.
  // UI redesign after final control removals: measured 335835/100662; approved gzip cap 101100.
  // USER APPROVED widget pin follow-up: app gzip cap 101100 → 101600; raw cap unchanged.
  // USER APPROVED round14 authoritative grid hydration fix: app gzip cap 101600 → 101700; all other caps unchanged.
  ["public/app.bundle.js", 386_000, 101_700],
  ["public/ghostty-web.bundle.js", 700_000, 210_000],
  // Phase-1 shell controls/full-view recovery: base 96978/17005; measured 100603/17595.
  // Selected-machine extensions + current main: approved raw cap 103000; measured 102177.
  // Harness icon chips + current main: approved raw cap 104000; measured 103477.
  // Notification prompt/test button: approved raw cap 104500; measured 104051.
  // UI redesign after final control removals: measured 112770/20859; approved caps 113200/21000.
  ["public/styles.css", 113_200, 21_000],
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
