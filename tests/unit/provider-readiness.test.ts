import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstalledProviderCommands,
  detectProviderReadiness,
  PROVIDER_DEFINITIONS,
} from "../../src/provider-readiness.ts";

const tempDirs: string[] = [];

function fakeExecutable(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wolfpack-provider-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider readiness", () => {
  test("covers every supported coding-agent provider with setup guidance", () => {
    expect(PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "cursor",
      "pi",
    ]);

    for (const provider of PROVIDER_DEFINITIONS) {
      expect(provider.command.length).toBeGreaterThan(0);
      expect(provider.installGuidance.length).toBeGreaterThan(0);
      expect(provider.loginCommand.length).toBeGreaterThan(0);
    }
  });

  test("detects Cursor Agent CLI as the cursor harness without probing versions", () => {
    const path = fakeExecutable("agent", "exit 99");

    expect(detectInstalledProviderCommands(path)).toEqual(["cursor"]);
  });

  test("reports Cursor Agent CLI under the cursor provider id", async () => {
    const path = fakeExecutable("agent", "printf 'Cursor Agent 1.2.3\\n'");

    const cursor = (await detectProviderReadiness({ path })).find((provider) => provider.id === "cursor");

    expect(cursor).toEqual({
      id: "cursor",
      displayName: "Cursor",
      command: "agent",
      status: "installed",
      executablePath: join(path, "agent"),
      version: "Cursor Agent 1.2.3",
      authStatus: "unknown",
      loginCommand: "agent",
    });
  });

  test("offers Cursor's documented Agent CLI install command when missing", async () => {
    const cursor = (await detectProviderReadiness({ path: undefined })).find((provider) => provider.id === "cursor");

    expect(cursor).toEqual({
      id: "cursor",
      displayName: "Cursor",
      command: "agent",
      status: "missing",
      installGuidance: "curl https://cursor.com/install -fsS | bash",
    });
  });

  test("reports a real executable path, bounded version, and unknown auth status", async () => {
    const path = fakeExecutable("claude", "printf 'Claude Code 9.8.7\\nignored detail\\n'");

    const providers = await detectProviderReadiness({ path });
    const claude = providers.find((provider) => provider.id === "claude");

    expect(claude).toEqual({
      id: "claude",
      displayName: "Claude Code",
      command: "claude",
      status: "installed",
      executablePath: join(path, "claude"),
      version: "Claude Code 9.8.7",
      authStatus: "unknown",
      loginCommand: "claude",
    });
    expect(providers.find((provider) => provider.id === "codex")).toMatchObject({
      status: "missing",
      installGuidance: "npm install -g @openai/codex",
    });
  });

  test("bounds version output before exposing it through the API", async () => {
    const longVersion = "v".repeat(220);
    const path = fakeExecutable("gemini", `printf '${longVersion}\\nignored\\n'`);

    const gemini = (await detectProviderReadiness({ path })).find((provider) => provider.id === "gemini");

    expect(gemini).toMatchObject({
      status: "installed",
      version: "v".repeat(160),
    });
  });

  test("keeps an installed provider usable when its version probe fails", async () => {
    const path = fakeExecutable("pi", "exit 2");

    const pi = (await detectProviderReadiness({ path })).find((provider) => provider.id === "pi");

    expect(pi).toMatchObject({
      id: "pi",
      status: "installed",
      executablePath: join(path, "pi"),
      version: null,
      authStatus: "unknown",
      loginCommand: "pi",
    });
  });
});
