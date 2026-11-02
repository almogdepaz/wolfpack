import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStylesheet } from "../../scripts/bundle-styles.ts";

test("native stylesheet generation is deterministic and matches the actual budgeted file", async () => {
  const css = await buildStylesheet();
  expect(await buildStylesheet()).toBe(css);
  expect(css).toBe(readFileSync(join(import.meta.dirname, "../../public/styles.css"), "utf8"));
  expect(css).toContain("edit src/browser/styles.css");
  expect(css).toContain("/wolfpack-icon.svg");
  expect(css).toContain("prefers-reduced-motion");
  expect(css).toContain("forced-colors");
});

test("missing stylesheet inputs fail with diagnostics instead of silently dropping authored rules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wp-style-build-"));
  try {
    const path = join(directory, "broken.css");
    writeFileSync(path, '@import "./missing.css";');
    await expect(buildStylesheet(path)).rejects.toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
