import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkContextLinks } from "../../scripts/check-context-links";

let root: string;
let manifest: Record<string, unknown>;
function save() { writeFileSync(join(root, "edc-context/manifest.json"), JSON.stringify(manifest)); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wolfpack-context-links-"));
  mkdirSync(join(root, "edc-context/modules"), { recursive: true });
  writeFileSync(join(root, "edc-context/index.md"), "Read `modules/runtime.md`.\n");
  writeFileSync(join(root, "edc-context/modules/runtime.md"), "# Runtime\n");
  manifest = { repoContextFile: "edc-context/index.md", modules: [{ name: "runtime", doc: "edc-context/modules/runtime.md" }], reports: {} };
  save();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("declared docs exist in this checkout", () => {
  expect(checkContextLinks(resolve(import.meta.dir, "../.."))).toEqual([]);
});
test("minimal valid routes, with optional empty reports", () => expect(checkContextLinks(root)).toEqual([]));
test("missing declared module fails", () => {
  rmSync(join(root, "edc-context/modules/runtime.md"));
  expect(checkContextLinks(root).some((e) => e.includes("modules[0].doc"))).toBe(true);
});
test("missing advertised reports and build info fail", () => {
  manifest.reports = { issues: "edc-context/reports/issues.md" };
  manifest.build = { buildInfoFile: "edc-context/build/build.json" }; save();
  const errors = checkContextLinks(root);
  expect(errors.some((e) => e.includes("reports.issues"))).toBe(true);
  expect(errors.some((e) => e.includes("build.buildInfoFile"))).toBe(true);
});
test("dangling index route fails even if no longer in manifest", () => {
  writeFileSync(join(root, "edc-context/index.md"), "`modules/tests.md` and [docs](modules/docs.md#overview)");
  const errors = checkContextLinks(root);
  expect(errors.filter((e) => e.includes("index module link"))).toHaveLength(2);
});
test("rejects malformed manifests rather than vacuous success", () => {
  for (const value of [null, [], {}, { repoContextFile: 3, modules: [], reports: [] }, { ...manifest, modules: [null] }]) {
    writeFileSync(join(root, "edc-context/manifest.json"), JSON.stringify(value));
    expect(checkContextLinks(root).length).toBeGreaterThan(0);
  }
  writeFileSync(join(root, "edc-context/manifest.json"), "{");
  expect(checkContextLinks(root)[0]).toContain("manifest");
});
test("rejects duplicate module names and directories as docs", () => {
  manifest.modules = [{ name: "runtime", doc: "edc-context/modules/runtime.md" }, { name: "runtime", doc: "edc-context/modules" }]; save();
  expect(checkContextLinks(root).some((e) => e.includes("duplicate"))).toBe(true);
  expect(checkContextLinks(root).some((e) => e.includes("regular file"))).toBe(true);
});
test("rejects traversal and symlink escapes", () => {
  manifest.modules = [{ name: "escape", doc: "../outside.md" }]; save();
  expect(checkContextLinks(root).some((e) => e.includes("repository-relative"))).toBe(true);
  const outside = join(root, "outside.md"); writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "edc-context/modules/alias.md"));
  // Internal symlinks are valid; escaping the canonical repository root is not.
  manifest.modules = [{ name: "alias", doc: "edc-context/modules/alias.md" }]; save();
  expect(checkContextLinks(root)).toEqual([]);
  rmSync(join(root, "edc-context/modules/alias.md"));
  symlinkSync("/etc/hosts", join(root, "edc-context/modules/alias.md"));
  expect(checkContextLinks(root).some((e) => e.includes("escapes repository"))).toBe(true);
});
