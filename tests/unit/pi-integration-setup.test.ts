import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("discloses exact package commands and user-permission risk before prompting", () => {
    const disclosure = piIntegrationDisclosureLines().join("\n");

    expect(disclosure).toContain("pi install npm:wolfpack-bridge");
    expect(disclosure).toContain("pi install npm:@sgtbeatdown/pi-tasks");
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

  test("installs Wolfpack skills before the Pi task extension", () => {
    const pi = fakePi();
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      env: { CALL_LOG: pi.callLog },
    });

    expect(result).toEqual({
      status: "installed",
      installedSources: PI_INTEGRATION_PACKAGES,
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe(
      "install npm:wolfpack-bridge\ninstall npm:@sgtbeatdown/pi-tasks\n",
    );
  });

  test("stops before installing the extension when Wolfpack skill installation fails", () => {
    const pi = fakePi();
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      env: {
        CALL_LOG: pi.callLog,
        FAIL_SOURCE: "npm:wolfpack-bridge",
      },
    });

    expect(result).toEqual({
      status: "failed",
      installedSources: [],
      failedSource: "npm:wolfpack-bridge",
      retryCommand: "pi install npm:wolfpack-bridge",
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:wolfpack-bridge\n");
  });

  test("reports a retry command when the task extension installation fails", () => {
    const pi = fakePi();
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      env: {
        CALL_LOG: pi.callLog,
        FAIL_SOURCE: "npm:@sgtbeatdown/pi-tasks",
      },
    });

    expect(result).toEqual({
      status: "failed",
      installedSources: ["npm:wolfpack-bridge"],
      failedSource: "npm:@sgtbeatdown/pi-tasks",
      retryCommand: "pi install npm:@sgtbeatdown/pi-tasks",
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe(
      "install npm:wolfpack-bridge\ninstall npm:@sgtbeatdown/pi-tasks\n",
    );
  });
});
