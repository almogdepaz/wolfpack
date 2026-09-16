import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests", "integration", "fixtures", "extension-native-acceptance.ts");
const AUTHORIZED_BROKER = "/private/tmp/wolfpack-extensions-native.DCYC5T/wolfpack-broker";
const broker = process.env.WOLFPACK_BROKER_BIN ?? AUTHORIZED_BROKER;

test.skipIf(!existsSync(broker))(
  "compiled public extension CLI persists documents through a real isolated broker-backed server",
  async () => {
    const result = Bun.spawnSync([process.execPath, FIXTURE], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", SHELL: process.env.SHELL ?? "/bin/sh", WOLFPACK_BROKER_BIN: broker },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    expect(result.exitCode).toBe(0);
    expect(result.signalCode ?? null).toBeNull();
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("extension-native-acceptance:");
  },
  130_000,
);
