#!/usr/bin/env bun
/** Builds checked-in, self-contained example extension UI bundles. Never runs at package install time. */
import { existsSync, mkdirSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const typecheck = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--project", join(root, "scripts", "extensions-samples.tsconfig.json")], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (typecheck.exitCode !== 0) throw new Error("extension sample typecheck failed");
const modules = join(root, "examples", "extensions", "node_modules");
const createdModules = !existsSync(modules);
const bridge = join(modules, "wolfpack-bridge");
if (existsSync(bridge)) throw new Error("refusing to replace an existing sample build dependency");
mkdirSync(modules, { recursive: true });
symlinkSync(root, bridge, "dir");
try {
  for (const name of ["agent-context", "notes"]) {
    const output = join(root, "examples", "extensions", name, "dist", "ui.js");
    mkdirSync(dirname(output), { recursive: true });
    const result = await Bun.build({
      entrypoints: [join(root, "examples", "extensions", name, "src", "ui.ts")],
      outdir: dirname(output),
      naming: "ui.js",
      format: "esm",
      target: "browser",
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) throw new Error(`${name} bundle failed: ${result.logs.map((log) => log.message).join("; ")}`);
  }
} finally {
  rmSync(bridge, { force: true });
  if (createdModules) { try { rmdirSync(modules); } catch { /* a concurrent owner populated it; retain it */ } }
}
