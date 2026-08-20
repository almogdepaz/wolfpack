import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_INTEGRATION_PACKAGES,
  acceptsPiIntegrationInstall,
  installPiIntegration,
  piIntegrationDisclosureLines,
  planPiIntegrationSetup,
} from "../../src/cli/pi-integration.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "wolfpack-pi-integration-"));
  tempDirs.push(directory);
  return directory;
}

function fakePi(): { readonly pathValue: string; readonly callLog: string } {
  const directory = tempDir();
  const executable = join(directory, "pi");
  const callLog = join(directory, "calls.log");
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "\${FAIL_SOURCE:-}" = "$2" ]; then
  exit 42
fi
if [ -n "\${REQUIRE_SKILL_PATH:-}" ] && [ ! -f "$REQUIRE_SKILL_PATH/SKILL.md" ]; then
  exit 43
fi
`);
  chmodSync(executable, 0o755);
  return { pathValue: directory, callLog };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi integration setup", () => {
  test("hides the integration for users without Pi", () => {
    expect(planPiIntegrationSetup(tempDir(), true)).toBe("hidden");
    expect(planPiIntegrationSetup(undefined, false)).toBe("hidden");
  });

  test("prompts interactive Pi users and only prints guidance without a TTY", () => {
    const pi = fakePi();

    expect(planPiIntegrationSetup(pi.pathValue, true)).toBe("prompt");
    expect(planPiIntegrationSetup(pi.pathValue, false)).toBe("guidance");
  });

  test("discloses the bundled Wolfpack skill and Pi Tasks extension", () => {
    const disclosure = piIntegrationDisclosureLines().join("\n");

    expect(disclosure).toContain("wolfpack-tailnet-control");
    expect(disclosure).toContain("pi install npm:@sgtbeatdown/pi-tasks");
    expect(disclosure).toContain("Wolfpack will install the skill");
    expect(disclosure).not.toContain("Pi will install the skill");
    expect(disclosure).not.toContain("npm:wolfpack-bridge");
    expect(disclosure).toContain("user permissions");
    expect(disclosure).toContain("Review");
  });

  test("keeps the integration default-no", () => {
    expect(acceptsPiIntegrationInstall("y")).toBe(true);
    expect(acceptsPiIntegrationInstall("Y")).toBe(true);
    expect(acceptsPiIntegrationInstall("")).toBe(false);
    expect(acceptsPiIntegrationInstall("n")).toBe(false);
    expect(acceptsPiIntegrationInstall("yes")).toBe(false);
  });

  test("installs the bundled control skill before the Pi Tasks extension", () => {
    const pi = fakePi();
    const piAgentDirectory = join(tempDir(), "agent");
    const skillPath = join(piAgentDirectory, "skills", "wolfpack-tailnet-control");
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      piAgentDirectory,
      env: {
        CALL_LOG: pi.callLog,
        REQUIRE_SKILL_PATH: skillPath,
      },
    });

    expect(result).toEqual({
      status: "installed",
      installedSources: PI_INTEGRATION_PACKAGES,
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/pi-tasks\n");
  });

  test("refuses to replace an existing Wolfpack skill before installing Pi Tasks", () => {
    const pi = fakePi();
    const piAgentDirectory = join(tempDir(), "agent");
    const skillPath = join(piAgentDirectory, "skills", "wolfpack-tailnet-control");
    mkdirSync(skillPath, { recursive: true });

    const result = installPiIntegration({
      pathValue: pi.pathValue,
      piAgentDirectory,
      env: { CALL_LOG: pi.callLog },
    });

    expect(result).toEqual({ status: "skill_exists", skillPath });
    expect(existsSync(pi.callLog)).toBe(false);
  });

  test("cleans a newly created skill directory when writing the skill fails", () => {
    const script = String.raw`
      import { mock } from "bun:test";
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      await mock.module("node:fs", () => ({
        ...fs,
        writeFileSync(file, ...args) {
          if (String(file).endsWith("/wolfpack-tailnet-control/SKILL.md")) {
            throw new Error("simulated write failure");
          }
          return fs.writeFileSync(file, ...args);
        },
      }));
      const { installPiIntegration } = await import("./src/cli/pi-integration.ts");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-pi-cleanup-"));
      const agent = path.join(root, "agent");
      const skill = path.join(agent, "skills", "wolfpack-tailnet-control");
      try {
        const result = installPiIntegration({ pathValue: "", piAgentDirectory: agent });
        if (result.status !== "skill_write_failed") throw new Error("expected skill write failure");
        if (fs.existsSync(skill)) throw new Error("partial skill directory was not removed");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
  });

  test("reports a retry command when Pi Tasks installation fails after skill installation", () => {
    const pi = fakePi();
    const piAgentDirectory = join(tempDir(), "agent");
    const skillPath = join(piAgentDirectory, "skills", "wolfpack-tailnet-control");
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      piAgentDirectory,
      env: {
        CALL_LOG: pi.callLog,
        FAIL_SOURCE: "npm:@sgtbeatdown/pi-tasks",
      },
    });

    expect(result).toEqual({
      status: "extension_failed",
      installedSources: [],
      failedSource: "npm:@sgtbeatdown/pi-tasks",
      retryCommand: "pi install npm:@sgtbeatdown/pi-tasks",
    });
    expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/pi-tasks\n");
  });
});
