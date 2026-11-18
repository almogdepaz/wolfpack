import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublicAssetsPresent } from "../public-assets-guard.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assetPath(): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-assets-guard-"));
  roots.push(root);
  return join(root, "public-assets.ts");
}

test("missing public assets explain the required generation step", () => {
  expect(() => assertPublicAssetsPresent(assetPath())).toThrow(
    "src/public-assets.ts missing: run bun run scripts/gen-assets.ts",
  );
});

test("present public assets allow tests to proceed", () => {
  const path = assetPath();
  writeFileSync(path, "");
  expect(() => assertPublicAssetsPresent(path)).not.toThrow();
});
