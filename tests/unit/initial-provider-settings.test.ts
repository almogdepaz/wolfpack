import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProviderSettingsFile } from "../../src/initial-provider-settings.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function providerPath(commands: readonly string[]): string {
  const dir = tempDir("wolfpack-initial-providers-");
  for (const command of commands) {
    const executablePath = join(dir, command);
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("initial provider settings", () => {
  test("creates shell plus detected providers as enabled commands", () => {
    const settingsPath = join(tempDir("wolfpack-initial-settings-"), "bridge-settings.json");

    const settings = initializeProviderSettingsFile({
      settingsPath,
      pathValue: providerPath(["codex", "gemini", "pi"]),
    });

    expect(settings).toEqual({
      agentCmd: "shell",
      cmds: [
        { cmd: "shell", enabled: true },
        { cmd: "codex", enabled: true },
        { cmd: "gemini", enabled: true },
        { cmd: "pi", enabled: true },
      ],
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(settings);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  test("creates shell-only settings when no provider is installed", () => {
    const settingsPath = join(tempDir("wolfpack-initial-settings-"), "bridge-settings.json");

    expect(initializeProviderSettingsFile({
      settingsPath,
      pathValue: providerPath([]),
    })).toEqual({
      agentCmd: "shell",
      cmds: [{ cmd: "shell", enabled: true }],
    });
  });

  test("never overwrites an existing settings file", () => {
    const settingsPath = join(tempDir("wolfpack-initial-settings-"), "bridge-settings.json");
    const existing = "{\"agentCmd\":\"custom\",\"cmds\":[]}";
    writeFileSync(settingsPath, existing);

    expect(initializeProviderSettingsFile({
      settingsPath,
      pathValue: providerPath(["claude"]),
    })).toBeNull();
    expect(readFileSync(settingsPath, "utf8")).toBe(existing);
  });
});
