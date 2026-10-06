#!/usr/bin/env bun
/** Builds the checked-in public authoring SDK; never runs during npm install. */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const output = join(root, "sdk");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o755 });
const bundle = await Bun.build({
  entrypoints: [join(root, "src", "extensions", "public-sdk.ts")],
  outdir: output,
  naming: "extensions.js",
  format: "esm",
  target: "browser",
  minify: false,
  sourcemap: "none",
});
if (!bundle.success) throw new Error(`extensions SDK bundle failed: ${bundle.logs.map((log) => log.message).join("; ")}`);
const declarations = Bun.spawnSync(["bunx", "tsc", "--project", join(root, "scripts", "extensions-sdk.tsconfig.json")], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (declarations.exitCode !== 0) throw new Error("extensions SDK declaration generation failed");
