import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const innerTestPath = join(process.cwd(), "tests", "unit", ".tmp-service-lifecycle-inner.test.ts");

const innerTest = String.raw`import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execCommands: string[] = [];
const askPrompts: string[] = [];
let curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });

await mock.module("node:child_process", () => ({
  execFile: mock(() => undefined),
  execFileSync: mock((command: string, args?: string[]) => {
    if (command === "curl" && args?.some((arg) => arg.includes("/api/backend"))) return curlBackendResponse;
    return "";
  }),
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
  ask: mock((prompt: string) => {
    askPrompts.push(prompt);
    return "y";
  }),
  isPortInUse: mock(() => true),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => ({ port: 18790 })),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { removeManagedEntrypoints, serviceRestart, serviceStop } = await import("../../src/cli/service.ts");

describe("removeManagedEntrypoints", () => {
  test("removes only symlinks resolving to the managed binary", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-uninstall-"));
    const managedBinary = join(root, "managed", "wolfpack");
    const managedEntrypoint = join(root, "bin", "wolfpack");
    const foreignBinary = join(root, "foreign", "wolfpack");
    const foreignEntrypoint = join(root, "bin", "foreign-wolfpack");
    try {
      mkdirSync(join(root, "managed"), { recursive: true });
      mkdirSync(join(root, "foreign"), { recursive: true });
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(managedBinary, "managed\\n");
      writeFileSync(foreignBinary, "foreign\\n");
      symlinkSync(managedBinary, managedEntrypoint);
      symlinkSync(foreignBinary, foreignEntrypoint);

      removeManagedEntrypoints([managedEntrypoint, foreignEntrypoint], managedBinary);

      expect(existsSync(managedEntrypoint)).toBe(false);
      expect(existsSync(foreignEntrypoint)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("serviceStop", () => {
  test("attempts broker shutdown when broker-inclusive server stop fails", () => {
    execCommands.length = 0;

    expect(serviceStop({ broker: true, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });
});

describe("serviceRestart", () => {
  test("uses one broker prompt that includes active session reset count", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });

    serviceRestart();

    expect(askPrompts).toEqual([
      "  Restart broker too? This will reset 3 active broker sessions. (y/n) ",
    ]);
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });

  test("server-only update restart does not prompt for or stop the broker", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    curlBackendResponse = JSON.stringify({ counts: { broker: 2 } });

    serviceRestart({ broker: false, skipBrokerSessionWarning: true });

    expect(askPrompts).toEqual([]);
    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
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
