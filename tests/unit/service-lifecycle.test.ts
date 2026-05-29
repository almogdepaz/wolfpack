import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const innerTestPath = join(process.cwd(), "tests", "unit", ".tmp-service-lifecycle-inner.test.ts");

const innerTest = String.raw`import { describe, expect, mock, test } from "bun:test";

const execCommands: string[] = [];

await mock.module("node:child_process", () => ({
  execFile: mock(() => undefined),
  execFileSync: mock(() => ""),
  execSync: mock((command: string) => {
    execCommands.push(command);
    if (command === "systemctl --user stop wolfpack") {
      throw new Error("server unit missing");
    }
    return "";
  }),
  spawn: mock(() => undefined),
  spawnSync: mock(() => ({ status: 0, stdout: "", stderr: "" })),
}));

await mock.module("../../src/cli/config.js", () => ({
  WOLFPACK_DIR: "/tmp/wolfpack-service-lifecycle-test",
  IS_MACOS: false,
  IS_LINUX: true,
  ask: mock(() => "n"),
  isPortInUse: mock(() => false),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => null),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { serviceStop } = await import("../../src/cli/service.ts");

describe("serviceStop", () => {
  test("attempts broker shutdown when broker-inclusive server stop fails", () => {
    execCommands.length = 0;

    expect(serviceStop({ broker: true, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });
});
`;

describe("service lifecycle", () => {
  test("broker-inclusive stop attempts broker shutdown even when server stop fails", () => {
    writeFileSync(innerTestPath, innerTest);
    try {
      const output = execFileSync(process.execPath, ["test", innerTestPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(output).toContain("Wolfpack broker stopped");
    } finally {
      rmSync(innerTestPath, { force: true });
    }
  });
});
