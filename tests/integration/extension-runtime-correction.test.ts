import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = "./tests/integration/fixtures/extension-runtime-correction-child.ts";

test("extension runtime correction regressions run in an owned child process", () => {
  const child = Bun.spawnSync([process.execPath, "test", fixture], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: { PATH: process.env.PATH ?? "", SHELL: process.env.SHELL ?? "/bin/sh" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  expect(child.exitCode).toBe(0);
  expect(child.signalCode ?? null).toBeNull();
  expect(child.stderr.toString()).toContain("14 pass");
  expect(child.stderr.toString()).toContain("0 fail");
}, 35_000);
