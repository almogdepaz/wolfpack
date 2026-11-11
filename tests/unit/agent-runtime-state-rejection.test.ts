import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["timer", "shutdown"]) {
  test(`runtime-state ${mode} logs a temporary-name failure and retries without an unhandled rejection`, () => {
    const home = mkdtempSync(join(tmpdir(), "runtime-state-rejection-"));
    mkdirSync(join(home, "zdotdir"));
    try {
      const result = spawnSync(process.execPath, [
        join(import.meta.dirname, "fixtures/agent-runtime-persistence-rejection.ts"), mode,
      ], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, HOME: home, ZDOTDIR: join(home, "zdotdir"), ENV: undefined, BASH_ENV: undefined,
          WOLFPACK_DIR: join(home, "state"), WOLFPACK_TEST: "1", WOLFPACK_LOG_LEVEL: "warn",
          WOLFPACK_AGENT_RUNTIME_STATE_PATH: join(home, "runtime.json"),
          WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"msg":"runtime state persistence failed"');
      expect(result.stdout).toContain('"error":"injected random source failure"');
      expect(result.stdout).toContain("persistence recovered");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 12_000);
}
