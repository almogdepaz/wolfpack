import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests", "integration", "fixtures", "extension-native-acceptance.ts");
// CI builds this exact repository output before its integration shard. Local
// runs must supply WOLFPACK_BROKER_BIN rather than silently treating absence as
// native acceptance coverage.
const broker = process.env.WOLFPACK_BROKER_BIN ?? join(ROOT, "broker", "target", "release", "wolfpack-broker");

test("compiled public extension CLI persists documents through a real isolated broker-backed server", async () => {
  expect(existsSync(broker)).toBe(true);
  const result = Bun.spawnSync([process.execPath, FIXTURE], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "", SHELL: process.env.SHELL ?? "/bin/sh", WOLFPACK_BROKER_BIN: broker,
      ...(process.env.WOLFPACK_BROKER_SHA256 === undefined ? {} : { WOLFPACK_BROKER_SHA256: process.env.WOLFPACK_BROKER_SHA256 }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  expect(result.exitCode).toBe(0);
  expect(result.signalCode ?? null).toBeNull();
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("extension-native-acceptance:");
}, 130_000);
