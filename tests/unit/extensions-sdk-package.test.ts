import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("builds a self-contained public extensions SDK with generated declarations", () => {
  const result = Bun.spawnSync([process.execPath, "scripts/build-extension-sdk.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.exports["./extensions"]).toEqual({ types: "./sdk/types/public-sdk.d.ts", import: "./sdk/extensions.js" });
  expect(readFileSync(join(root, "sdk", "extensions.js"), "utf8")).not.toMatch(/from\s+['"]/);
  expect(readFileSync(join(root, "sdk", "types", "public-sdk.d.ts"), "utf8")).toContain("ContextViewContribution");
});

test("packs a consumer-importable SDK without installation scripts or checkout source resolution", async () => {
  const staging = mkdtempSync(join(tmpdir(), "wolfpack-sdk-pack-")); temporary.push(staging);
  const packed = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", staging], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(packed.exitCode).toBe(0);
  const [{ filename }] = JSON.parse(packed.stdout.toString()) as Array<{ filename: string }>;
  const consumer = join(staging, "consumer");
  mkdirSync(consumer, { recursive: true });
  const extracted = Bun.spawnSync(["tar", "-xzf", join(staging, filename), "-C", consumer], { stdout: "pipe", stderr: "pipe" });
  expect(extracted.exitCode).toBe(0);
  const packageRoot = join(consumer, "package");
  const nodeModules = join(consumer, "node_modules");
  const linked = Bun.spawnSync(["mkdir", "-p", nodeModules], { stdout: "pipe", stderr: "pipe" });
  expect(linked.exitCode).toBe(0);
  const placed = Bun.spawnSync(["ln", "-s", "../package", join(nodeModules, "wolfpack-bridge")], { stdout: "pipe", stderr: "pipe" });
  expect(placed.exitCode).toBe(0);
  const entry = join(consumer, "entry.ts");
  await Bun.write(entry, 'import { leadStackLayout, EXTENSION_LIFECYCLE_RULES_VERSION } from "wolfpack-bridge/extensions";\nconst value = leadStackLayout({ panes: [{ id: "one" }, { id: "two" }], selectedPaneId: "one", viewport: { width: 1, height: 1 } });\nif (value.version !== EXTENSION_LIFECYCLE_RULES_VERSION) throw new Error("bad SDK");\n');
  const built = Bun.spawnSync([process.execPath, "build", entry, "--outfile", join(consumer, "bundle.js")], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
  expect(built.exitCode).toBe(0);
});
