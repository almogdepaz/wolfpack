import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const TARGET_TEST = join(ROOT, "tests", "integration", "control-api-schema-contract.test.ts");
const PRELOAD = join(ROOT, "tests", "integration", "fixtures", "control-api-schema-temp-cleanup-preload.ts");
const CHILD_TIMEOUT_MS = 3_000;

test("schema contract cleanup does not delete a planted temp-root target", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "wolfpack-schema-cleanup-regression-"));
  const victim = join(sandbox, "victim");
  const sentinel = join(victim, "sentinel");
  let child: Bun.Subprocess<"pipe", "ignore", "inherit"> | undefined;
  let exited: Promise<number> | undefined;

  try {
    mkdirSync(victim);
    writeFileSync(sentinel, "keep me");
    child = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, TARGET_TEST], {
      cwd: ROOT,
      env: { ...process.env, TMPDIR: sandbox },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    exited = child.exited;

    symlinkSync(victim, join(sandbox, `wolfpack-schema-contract-${child.pid}`));
    await child.stdin.end();

    expect(await exited).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (exited) await exited;
    rmSync(sandbox, { recursive: true, force: true });
  }
}, { timeout: 4_500 });
