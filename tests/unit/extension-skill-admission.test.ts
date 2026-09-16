import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(skill: "missing" | "invalid") {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-skill-admission-")); roots.push(root);
  const source = join(root, "package"); mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "dist", "ui.js"), "export default null;\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "skill-admission", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "skill-admission", ui: "dist/ui.js", documents: [], skills: ["skills/admission-skill"] } }));
  if (skill === "invalid") { mkdirSync(join(source, "skills", "admission-skill"), { recursive: true }); writeFileSync(join(source, "skills", "admission-skill", "SKILL.md"), "invalid frontmatter\n"); }
  return { source, runtime: new ExtensionRuntime({ root: join(root, "runtime"), installationId: "11111111-1111-4111-8111-111111111111" }), skillsRoot: join(root, "skills-root") };
}

test("missing declared skills reject admission before an extension becomes active", async () => {
  const value = fixture("missing");
  await expect(value.runtime.install({ source: value.source, trustBrowserCode: true })).rejects.toThrow();
  expect(value.runtime.catalog().installations).toEqual([]);
});
test("invalid declared skills reject explicit deployment before registry or discovery effects", async () => {
  const value = fixture("invalid");
  await expect(value.runtime.install({ source: value.source, trustBrowserCode: true, skillsRoot: value.skillsRoot })).rejects.toThrow();
  expect(value.runtime.catalog().installations).toEqual([]);
  expect(existsSync(value.skillsRoot)).toBe(false);
});
