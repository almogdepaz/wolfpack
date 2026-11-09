import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import {
  LEGACY_PI_TASKS_PACKAGE,
  PI_INTEGRATION_PACKAGES,
  PI_TASKS_MIGRATION_COMMANDS,
  acceptsPiIntegrationInstall,
  findLegacyPiTasksSource,
  migratePiTasksPackage,
  piTasksMigrationDisclosureLines,
  piTasksRestoreHintLines,
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
  const executable = join(directory, AGENT_KIND.PI.cmd);
  const callLog = join(directory, "calls.log");
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "\${FAIL_SOURCE:-}" = "$2" ]; then
  exit 42
fi
# Stand in for Pi's own settings.json update.
if [ "$1" = remove ] && [ -n "\${PI_SETTINGS_AFTER_REMOVE:-}" ]; then
  /bin/cp "$PI_SETTINGS_AFTER_REMOVE" "$PI_CODING_AGENT_DIR/settings.json"
fi
if [ "$1" = install ] && [ -n "\${PI_SETTINGS_AFTER_INSTALL:-}" ]; then
  /bin/cp "$PI_SETTINGS_AFTER_INSTALL" "$PI_CODING_AGENT_DIR/settings.json"
fi
if [ -n "\${REQUIRE_SKILL_PATH:-}" ] && [ ! -f "$REQUIRE_SKILL_PATH/SKILL.md" ]; then
  exit 43
fi
`);
  chmodSync(executable, 0o755);
  return { pathValue: directory, callLog };
}

function installedMarkdownReferences(skillPath: string): readonly { readonly from: string; readonly target: string }[] {
  const references: { from: string; target: string }[] = [];
  for (const entry of readdirSync(skillPath, { recursive: true })) {
    if (typeof entry !== "string" || !entry.endsWith(".md")) continue;
    const markdownPath = join(skillPath, entry);
    const markdown = readFileSync(markdownPath, "utf8");
    for (const match of markdown.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g)) {
      const destination = match[1] ?? match[2];
      if (!destination || destination.startsWith("#") || destination.startsWith("//")) continue;
      const destinationUrl = new URL(destination, pathToFileURL(markdownPath));
      if (destinationUrl.protocol !== "file:") continue;
      references.push({ from: markdownPath, target: fileURLToPath(destinationUrl) });
    }
  }
  return references;
}

function expectSkillWriteFailure(filename: string): void {
  const script = String.raw`
    import { mock } from "bun:test";
    const fs = await import("node:fs");
    // ESM namespace exports are live; don't recurse into our own mock on newer Bun.
    const realWriteFileSync = fs.writeFileSync;
    const path = await import("node:path");
    const os = await import("node:os");
    await mock.module("node:fs", () => ({
      ...fs,
      writeFileSync(file, ...args) {
        if (String(file).endsWith("/wolfpack-tailnet-control/${filename}")) {
          throw new Error("simulated write failure");
        }
        return realWriteFileSync(file, ...args);
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
    expect(disclosure).toContain(`${AGENT_KIND.PI.cmd} install npm:@sgtbeatdown/wolfpack-tasks`);
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
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/wolfpack-tasks\n");
  });

  test("installs every local Markdown reference from the bundled control skill", () => {
    const pi = fakePi();
    const piAgentDirectory = join(tempDir(), "agent");
    const skillPath = join(piAgentDirectory, "skills", "wolfpack-tailnet-control");

    const result = installPiIntegration({
      pathValue: pi.pathValue,
      piAgentDirectory,
      env: { CALL_LOG: pi.callLog },
    });

    expect(result).toEqual({
      status: "installed",
      installedSources: PI_INTEGRATION_PACKAGES,
    });
    const references = installedMarkdownReferences(skillPath);
    expect(references).not.toHaveLength(0);
    for (const { from, target } of references) {
      expect(relative(skillPath, target).startsWith("..")).toBe(false);
      expect(existsSync(target), `${relative(skillPath, from)} references ${relative(skillPath, target)}`).toBe(true);
    }
  });

  test("discovers extensionless local Markdown destinations", () => {
    const skillPath = tempDir();
    writeFileSync(join(skillPath, "SKILL.md"), [
      "[local reference](references/control#teardown)",
      "[remote reference](https://example.com/reference)",
    ].join("\n"));

    expect(installedMarkdownReferences(skillPath)).toEqual([
      { from: join(skillPath, "SKILL.md"), target: join(skillPath, "references", "control") },
    ]);
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
    expectSkillWriteFailure("SKILL.md");
  });

  test("cleans a newly created skill directory when writing references fails", () => {
    expectSkillWriteFailure("references.md");
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
        FAIL_SOURCE: "npm:@sgtbeatdown/wolfpack-tasks",
      },
    });

    expect(result).toEqual({
      status: "extension_failed",
      installedSources: [],
      failedSource: "npm:@sgtbeatdown/wolfpack-tasks",
      retryCommand: `${AGENT_KIND.PI.cmd} install npm:@sgtbeatdown/wolfpack-tasks`,
    });
    expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/wolfpack-tasks\n");
  });
});

describe("Pi Tasks package migration", () => {
  function agentWithPackages(packages: unknown): string {
    const agent = tempDir();
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages }));
    return agent;
  }

  test("detects the legacy package as a plain, versioned, or object source", () => {
    expect(LEGACY_PI_TASKS_PACKAGE).toBe("npm:@sgtbeatdown/pi-tasks");
    expect(findLegacyPiTasksSource(agentWithPackages(["npm:@sgtbeatdown/pi-tasks"]))).toBe("npm:@sgtbeatdown/pi-tasks");
    expect(findLegacyPiTasksSource(agentWithPackages([
      "npm:other",
      { source: "npm:@sgtbeatdown/pi-tasks@0.1.17", skills: ["!skills/x/**"] },
    ]))).toBe("npm:@sgtbeatdown/pi-tasks@0.1.17");
  });

  test("ignores the renamed package, look-alike names, and missing or malformed settings", () => {
    expect(findLegacyPiTasksSource(agentWithPackages(["npm:@sgtbeatdown/wolfpack-tasks"]))).toBeUndefined();
    expect(findLegacyPiTasksSource(agentWithPackages(["npm:@sgtbeatdown/pi-tasks-extra"]))).toBeUndefined();
    expect(findLegacyPiTasksSource(agentWithPackages("npm:@sgtbeatdown/pi-tasks"))).toBeUndefined();
    expect(findLegacyPiTasksSource(tempDir())).toBeUndefined();
    const malformed = tempDir();
    writeFileSync(join(malformed, "settings.json"), "{");
    expect(findLegacyPiTasksSource(malformed)).toBeUndefined();
  });

  test("discloses remove-then-install commands", () => {
    expect(PI_TASKS_MIGRATION_COMMANDS).toEqual([
      `${AGENT_KIND.PI.cmd} remove npm:@sgtbeatdown/pi-tasks`,
      `${AGENT_KIND.PI.cmd} install npm:@sgtbeatdown/wolfpack-tasks`,
    ]);
    const disclosure = piTasksMigrationDisclosureLines("npm:@sgtbeatdown/pi-tasks@0.1.17").join("\n");
    expect(disclosure).toContain("npm:@sgtbeatdown/pi-tasks@0.1.17");
    for (const command of PI_TASKS_MIGRATION_COMMANDS) expect(disclosure).toContain(command);
  });

  test("removes the legacy package before installing the renamed one", () => {
    const pi = fakePi();
    expect(migratePiTasksPackage({ pathValue: pi.pathValue, env: { CALL_LOG: pi.callLog, PI_CODING_AGENT_DIR: tempDir() } }))
      .toEqual({ status: "migrated" });
    expect(readFileSync(pi.callLog, "utf8"))
      .toBe("remove npm:@sgtbeatdown/pi-tasks\ninstall npm:@sgtbeatdown/wolfpack-tasks\n");
  });

  test("stops at the failed command and reports the remaining retry commands", () => {
    const pi = fakePi();
    expect(migratePiTasksPackage({
      pathValue: pi.pathValue,
      env: { CALL_LOG: pi.callLog, FAIL_SOURCE: "npm:@sgtbeatdown/pi-tasks", PI_CODING_AGENT_DIR: tempDir() },
    })).toEqual({
      status: "failed",
      failedCommand: PI_TASKS_MIGRATION_COMMANDS[0],
      retryCommands: PI_TASKS_MIGRATION_COMMANDS,
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe("remove npm:@sgtbeatdown/pi-tasks\n");

    const second = fakePi();
    expect(migratePiTasksPackage({
      pathValue: second.pathValue,
      env: { CALL_LOG: second.callLog, FAIL_SOURCE: "npm:@sgtbeatdown/wolfpack-tasks", PI_CODING_AGENT_DIR: tempDir() },
    })).toEqual({
      status: "failed",
      failedCommand: PI_TASKS_MIGRATION_COMMANDS[1],
      retryCommands: [PI_TASKS_MIGRATION_COMMANDS[1]],
    });
  });

  describe("resource filters", () => {
    const legacyEntry = {
      source: "npm:@sgtbeatdown/pi-tasks@0.1.17",
      skills: ["!skills/wolfpack-pi-task-delegation/**", "!skills/other/**"],
      extensions: ["!extensions/legacy.ts"],
    };

    /** A fake Pi agent directory whose settings.json moves through `before`, `afterRemove`, `afterInstall`. */
    function migrationFixture(settings: { before: unknown; afterRemove: unknown; afterInstall: unknown }) {
      const agent = tempDir();
      const settingsPath = join(agent, "settings.json");
      writeFileSync(settingsPath, `${JSON.stringify(settings.before, null, 2)}\n`);
      const afterRemove = join(tempDir(), "after-remove.json");
      const afterInstall = join(tempDir(), "after-install.json");
      writeFileSync(afterRemove, `${JSON.stringify(settings.afterRemove, null, 2)}\n`);
      writeFileSync(afterInstall, `${JSON.stringify(settings.afterInstall, null, 2)}\n`);
      const pi = fakePi();
      const env = {
        CALL_LOG: pi.callLog,
        PI_CODING_AGENT_DIR: agent,
        PI_SETTINGS_AFTER_REMOVE: afterRemove,
        PI_SETTINGS_AFTER_INSTALL: afterInstall,
      };
      return { pi, env, settingsPath, afterInstall };
    }

    test("carry the legacy entry's filters to the new entry and rename the delegation skill path", () => {
      const fixture = migrationFixture({
        before: { theme: "dark", packages: ["npm:other", legacyEntry] },
        afterRemove: { theme: "dark", packages: ["npm:other"] },
        afterInstall: { theme: "dark", packages: ["npm:other", "npm:@sgtbeatdown/wolfpack-tasks"] },
      });
      expect(migratePiTasksPackage({ pathValue: fixture.pi.pathValue, env: fixture.env })).toEqual({ status: "migrated" });
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8"))).toEqual({
        theme: "dark",
        packages: [
          "npm:other",
          {
            source: "npm:@sgtbeatdown/wolfpack-tasks",
            skills: ["!skills/wolfpack-task-delegation/**", "!skills/other/**"],
            extensions: ["!extensions/legacy.ts"],
          },
        ],
      });
    });

    test("leave Pi's settings untouched when the legacy entry has no filters", () => {
      const fixture = migrationFixture({
        before: { packages: ["npm:@sgtbeatdown/pi-tasks"] },
        afterRemove: { packages: [] },
        afterInstall: { packages: ["npm:@sgtbeatdown/wolfpack-tasks"] },
      });
      expect(migratePiTasksPackage({ pathValue: fixture.pi.pathValue, env: fixture.env })).toEqual({ status: "migrated" });
      expect(readFileSync(fixture.settingsPath, "utf8")).toBe(readFileSync(fixture.afterInstall, "utf8"));
    });

    test("report the entry to restore by hand when the new entry is missing after install", () => {
      const fixture = migrationFixture({
        before: { packages: [legacyEntry] },
        afterRemove: { packages: [] },
        afterInstall: { packages: [] },
      });
      const restoreEntry = {
        source: "npm:@sgtbeatdown/wolfpack-tasks",
        skills: ["!skills/wolfpack-task-delegation/**", "!skills/other/**"],
        extensions: ["!extensions/legacy.ts"],
      };
      expect(migratePiTasksPackage({ pathValue: fixture.pi.pathValue, env: fixture.env })).toEqual({
        status: "filters_not_restored",
        settingsPath: fixture.settingsPath,
        restoreEntry,
      });
      expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8"))).toEqual({ packages: [] });
    });

    test("print the entry to restore with its settings path", () => {
      const entry = { source: "npm:@sgtbeatdown/wolfpack-tasks", skills: ["!skills/wolfpack-task-delegation/**"] };
      expect(piTasksRestoreHintLines({ settingsPath: "/agent/settings.json", restoreEntry: entry })).toEqual([
        "  Pi Tasks resource filters were not kept. Replace the wolfpack-tasks entry in packages in /agent/settings.json with:",
        `    ${JSON.stringify(entry)}`,
      ]);
    });

    test("report the entry to restore by hand when install fails after the legacy entry is removed", () => {
      const fixture = migrationFixture({
        before: { packages: [legacyEntry] },
        afterRemove: { packages: [] },
        afterInstall: { packages: [] },
      });
      expect(migratePiTasksPackage({
        pathValue: fixture.pi.pathValue,
        env: { ...fixture.env, FAIL_SOURCE: "npm:@sgtbeatdown/wolfpack-tasks" },
      })).toEqual({
        status: "failed",
        failedCommand: PI_TASKS_MIGRATION_COMMANDS[1],
        retryCommands: [PI_TASKS_MIGRATION_COMMANDS[1]],
        settingsPath: fixture.settingsPath,
        restoreEntry: {
          source: "npm:@sgtbeatdown/wolfpack-tasks",
          skills: ["!skills/wolfpack-task-delegation/**", "!skills/other/**"],
          extensions: ["!extensions/legacy.ts"],
        },
      });
    });
  });
});
