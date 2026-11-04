import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const SOURCE_FILES = ["dist/ghostty-web.js", "dist/index.d.ts", "dist/__vite-browser-external-2447137e.js", "LICENSE"] as const;
const OUTPUT_FILES = ["dist/ghostty-web.js", "dist/index.d.ts"] as const;
type SourceFile = typeof SOURCE_FILES[number];
type OutputFile = typeof OUTPUT_FILES[number];
interface StageLock {
  readonly formatVersion: 1;
  readonly package: { readonly name: "ghostty-web"; readonly version: string };
  readonly basePatchSha256: string;
  readonly patchSha256: string;
  readonly inputs: Readonly<Record<SourceFile, { readonly bytes: number; readonly sha256: string }>>;
  readonly outputs: Readonly<Record<OutputFile, string>>;
}
export interface GhosttyWebStage {
  readonly directory: string;
  readonly esmPath: string;
  readonly typesPath: string;
  readonly license: string;
  readonly version: string;
}
export interface GhosttyWebStageOptions {
  readonly packageRoot?: string;
  readonly lockPath?: string;
  readonly patchPath?: string;
  readonly stageParent?: string;
}
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function boundedFile(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maximum) throw new Error(`Ghostty stage requires a bounded regular input: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== stat.size) throw new Error(`Ghostty stage input changed while reading: ${path}`);
  return bytes;
}
function assertStageLock(value: unknown, path: string): asserts value is StageLock {
  if (!object(value) || value.formatVersion !== 1 || !object(value.package) || value.package.name !== "ghostty-web"
    || value.package.version !== "0.4.0" || !digest(value.basePatchSha256) || !digest(value.patchSha256)
    || !object(value.inputs) || Object.keys(value.inputs).length !== SOURCE_FILES.length
    || !object(value.outputs) || Object.keys(value.outputs).length !== OUTPUT_FILES.length) throw new Error(`Invalid Ghostty stage provenance: ${path}`);
  for (const file of SOURCE_FILES) {
    const input = value.inputs[file];
    if (!object(input) || typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 4 * 1024 * 1024 || !digest(input.sha256)) {
      throw new Error(`Invalid Ghostty stage input provenance for ${file}`);
    }
  }
  for (const file of OUTPUT_FILES) if (!digest(value.outputs[file])) throw new Error(`Invalid Ghostty stage output provenance for ${file}`);
}
function readLock(path: string): StageLock {
  const value: unknown = JSON.parse(boundedFile(path, 16 * 1024).toString("utf8"));
  assertStageLock(value, path);
  return value;
}

/** Only four pinned distribution inputs are staged. Never edits the installed
 * package, its caches, or the existing Bun patch. Declaration CRLF is normalized
 * in the private stage so unified hunks apply portably with exact line numbers. */
export async function withGhosttyWebStage<T>(operation: (stage: GhosttyWebStage) => Promise<T>, options: GhosttyWebStageOptions = {}): Promise<T> {
  const lock = readLock(options.lockPath ?? join(ROOT, "patches/ghostty-web-render-suspension.json"));
  const packageRoot = options.packageRoot ?? join(ROOT, "node_modules/ghostty-web");
  const pkg: unknown = JSON.parse(boundedFile(join(packageRoot, "package.json"), 32 * 1024).toString("utf8"));
  if (!object(pkg) || pkg.name !== lock.package.name || pkg.version !== lock.package.version) {
    throw new Error(`Ghostty stage requires installed ghostty-web@${lock.package.version}; verify the existing lockfile/dependency input, do not auto-install`);
  }
  const basePatch = boundedFile(join(ROOT, "patches/ghostty-web@0.4.0.patch"), 4 * 1024 * 1024);
  const patchPath = options.patchPath ?? join(ROOT, "patches/ghostty-web-render-suspension.patch");
  const patch = boundedFile(patchPath, 128 * 1024);
  if (sha256(basePatch) !== lock.basePatchSha256 || sha256(patch) !== lock.patchSha256) throw new Error("Ghostty stage patch digest drift; review the repository patch and provenance together");
  const inputs = new Map<SourceFile, Buffer>();
  for (const file of SOURCE_FILES) {
    const expected = lock.inputs[file];
    const bytes = boundedFile(join(packageRoot, file), expected.bytes);
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`Ghostty stage input drift at ${file}; expected the exact installed Wolfpack base-patched distribution. Review dependency/patch provenance; no fuzz, offset or automatic repair is allowed`);
    }
    inputs.set(file, bytes);
  }
  const directory = mkdtempSync(join(options.stageParent ?? tmpdir(), "wolfpack-ghostty-web-"));
  try {
    for (const [file, bytes] of inputs) {
      const path = join(directory, file);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file === "dist/index.d.ts" ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes, { mode: 0o600 });
    }
    // Apply only verified bytes, not a pathname that can change after hashing.
    // Native patch has no structured offset result: pin its diagnostic locale,
    // reject any offset/fuzz, then independently verify the exact output hashes.
    const applied = spawnSync("patch", ["-p1", "--fuzz=0", "--batch", "--forward"], { cwd: directory, input: patch, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    const diagnostic = `${applied.stdout ?? ""}${applied.stderr ?? ""}`;
    if (applied.error || applied.status !== 0 || /\b(offset|fuzz)\b/i.test(diagnostic)) {
      throw new Error(`Ghostty stage requires exact unified hunks (no fuzz/offset); verify patch tool and pinned inputs: ${applied.error?.message ?? diagnostic}`);
    }
    for (const file of OUTPUT_FILES) if (sha256(boundedFile(join(directory, file), 4 * 1024 * 1024)) !== lock.outputs[file]) {
      throw new Error(`Ghostty stage output drift at ${file}; review the suspension patch/provenance, do not bypass verification`);
    }
    return await operation({ directory, esmPath: join(directory, "dist/ghostty-web.js"), typesPath: join(directory, "dist/index.d.ts"), license: inputs.get("LICENSE")!.toString("utf8"), version: lock.package.version });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Build UMD-compatible global exposure from the one patched ESM implementation,
 * rather than maintaining a second minified implementation patch. */
export async function buildGhosttyWebCore(stage: GhosttyWebStage): Promise<string> {
  const entry = join(stage.directory, "wolfpack-entry.js");
  writeFileSync(entry, 'import * as api from "./dist/ghostty-web.js"; globalThis.GhosttyWeb = api;\n');
  const result = await Bun.build({ entrypoints: [entry], root: stage.directory, target: "browser", format: "iife", minify: true, sourcemap: "none" });
  if (!result.success || result.outputs.length !== 1) throw new Error(`Ghostty stage browser build failed: ${result.logs.map(String).join("\n")}`);
  return `/*! ghostty-web ${stage.version}; Wolfpack-supported staged render API (not upstream).\n${stage.license}\n*/\n${await result.outputs[0]!.text()}`;
}
