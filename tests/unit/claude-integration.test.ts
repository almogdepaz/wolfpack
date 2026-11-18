import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CHANNEL_DROP_IN,
  CLAUDE_INTEGRATION,
  CLAUDE_TASK_INTEGRATION_OFF_ERROR,
  claudeChannelDropInContent,
  claudeManagedSettingsDropInDirectory,
  activeClaudeManagedSettingsDropInDirectory,
  claudeTaskIntegrationGate,
} from "../../src/claude-integration.ts";

// Phase A contract: wolfpack-tasks `src/claude/constants.ts` (`CLAUDE_PLUGIN`). A change
// here breaks installed plugins, so it must change in both repositories together.
describe("claude integration constants", () => {
  test("pin the names the wolfpack-tasks plugin uses", () => {
    expect(CLAUDE_INTEGRATION).toEqual({
      marketplace: "wolfpack-tasks",
      plugin: "wolfpack-tasks",
      marketplaceSource: "almogdepaz/wolfpack-tasks",
      channelSpec: "plugin:wolfpack-tasks@wolfpack-tasks",
      pluginSpec: "wolfpack-tasks@wolfpack-tasks",
      dropInFileName: "wolfpack.json",
      minimumClaudeVersion: "2.1.319",
      statusDirectory: "wolfpack-tasks/claude",
    });
  });

  test("drop-in selection preserves platform default and explicit absent-directory semantics", () => {
    expect(activeClaudeManagedSettingsDropInDirectory()).toBe(claudeManagedSettingsDropInDirectory());
    expect(activeClaudeManagedSettingsDropInDirectory({ directory: "/private/fixture/managed-settings.d" }))
      .toBe("/private/fixture/managed-settings.d");
    expect(activeClaudeManagedSettingsDropInDirectory({ directory: undefined })).toBeUndefined();
  });

  test("pin the managed-settings drop-in content and directories", () => {
    expect(CLAUDE_CHANNEL_DROP_IN).toEqual({
      channelsEnabled: true,
      allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "wolfpack-tasks" }],
    });
    expect(JSON.parse(claudeChannelDropInContent())).toEqual(CLAUDE_CHANNEL_DROP_IN);
    expect(claudeChannelDropInContent().endsWith("}\n")).toBe(true);
    expect(claudeManagedSettingsDropInDirectory("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-settings.d");
    expect(claudeManagedSettingsDropInDirectory("linux")).toBe("/etc/claude-code/managed-settings.d");
    expect(claudeManagedSettingsDropInDirectory("win32")).toBeUndefined();
  });
});

describe("effective claude task integration gate", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function dropInDirectory(content?: string): string {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-claude-gate-"));
    roots.push(root);
    if (content !== undefined) writeFileSync(join(root, CLAUDE_INTEGRATION.dropInFileName), content);
    return root;
  }

  test("is on only with the flag and the current drop-in", () => {
    expect(claudeTaskIntegrationGate(true, dropInDirectory(claudeChannelDropInContent()))).toEqual({ on: true });
    // Extra keys and entries are allowed, as in doctor's drop-in check.
    expect(claudeTaskIntegrationGate(true, dropInDirectory(JSON.stringify({
      channelsEnabled: true,
      allowedChannelPlugins: [{ plugin: "other", marketplace: "other" }, ...CLAUDE_CHANNEL_DROP_IN.allowedChannelPlugins],
      extra: 1,
    })))).toEqual({ on: true });
  });

  test("is off with the setup error while the flag is off", () => {
    expect(claudeTaskIntegrationGate(false, dropInDirectory(claudeChannelDropInContent())))
      .toEqual({ on: false, error: CLAUDE_TASK_INTEGRATION_OFF_ERROR });
  });

  test("is off on a platform without a drop-in directory", () => {
    const gate = claudeTaskIntegrationGate(true, undefined);
    expect(gate.on).toBe(false);
    expect(gate.on ? "" : gate.error).toContain("no supported managed-settings drop-in directory");
  });

  for (const [name, content, problem] of [
    ["absent", undefined, "is missing"],
    ["malformed", "{not json", "is not a JSON object"],
    ["channels disabled", JSON.stringify({ ...CLAUDE_CHANNEL_DROP_IN, channelsEnabled: false }), "does not set channelsEnabled to true"],
    ["wrong allowlist", JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "other" }] }),
      `does not allow the ${CLAUDE_INTEGRATION.channelSpec} channel`],
  ] as const) {
    test(`is off when the drop-in is ${name}, and names the file, setup and doctor`, () => {
      const directory = dropInDirectory(content);
      const gate = claudeTaskIntegrationGate(true, directory);
      expect(gate.on).toBe(false);
      const error = gate.on ? "" : gate.error;
      expect(error).toContain(`${join(directory, CLAUDE_INTEGRATION.dropInFileName)} ${problem}`);
      expect(error).toContain("wolfpack setup");
      expect(error).toContain("wolfpack doctor");
    });
  }
});
