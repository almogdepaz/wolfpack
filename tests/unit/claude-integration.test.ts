import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CHANNEL_DROP_IN,
  CLAUDE_INTEGRATION,
  claudeChannelDropInContent,
  claudeManagedSettingsDropInDirectory,
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
      gateFileSuffix: ".gate.json",
    });
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
