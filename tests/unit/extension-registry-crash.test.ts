import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("registry remains coherent after crashes at locked filesystem call boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-registry-crash-"));
  let passed = false;
  try {
    for (const dir of ["home", "zdotdir", "state"]) mkdirSync(join(root, dir));
    const result = spawnSync(process.execPath, [
      join(import.meta.dirname, "fixtures", "extension-registry-crash-sweep.ts"),
      join(root, "sweep"),
    ], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: join(root, "home"), ZDOTDIR: join(root, "zdotdir"),
        WOLFPACK_DIR: join(root, "state"), WOLFPACK_TEST: "1",
        ENV: undefined, BASH_ENV: undefined,
        WP_CRASH_AT: undefined, WP_CRASH_ROOT: undefined,
      },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`crash sweep failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
    }
    const summary = JSON.parse(readFileSync(join(root, "sweep", "results.json"), "utf8")) as {
      seconds: number;
      records: Array<{ op: string; killed: boolean; stranded: boolean; busy: boolean; faults: unknown[] }>;
    };
    expect(new Set(summary.records.map(record => record.op))).toEqual(new Set([
      "install-v1", "install-v2", "remove", "purge",
    ]));
    for (const op of ["install-v1", "install-v2", "remove", "purge"]) {
      const records = summary.records.filter(record => record.op === op);
      expect(records.filter(record => !record.killed)).toHaveLength(1);
      expect(records.some(record => record.stranded && record.busy)).toBe(true);
      expect(records.every(record => record.faults.length === 0)).toBe(true);
    }
    console.info(`registry crash sweep: ${summary.records.length} trials in ${summary.seconds.toFixed(3)}s`);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`registry crash evidence retained at ${root}`);
  }
}, 65_000);
