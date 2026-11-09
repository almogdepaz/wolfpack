/**
 * Claude Code task integration names shared by setup, spawn, readiness and doctor.
 * Values match the wolfpack-tasks plugin's `CLAUDE_PLUGIN` (`src/claude/constants.ts`);
 * `tests/unit/claude-integration.test.ts` pins them.
 */
export const CLAUDE_INTEGRATION = Object.freeze({
  marketplace: "wolfpack-tasks",
  plugin: "wolfpack-tasks",
  /** `claude plugin marketplace add` source (GitHub owner/repo). */
  marketplaceSource: "almogdepaz/wolfpack-tasks",
  /** `claude --channels` argument that enables the plugin's channel. */
  channelSpec: "plugin:wolfpack-tasks@wolfpack-tasks",
  /** `claude plugin install` argument. */
  pluginSpec: "wolfpack-tasks@wolfpack-tasks",
  /** Managed-settings drop-in file name that wolfpack owns. */
  dropInFileName: "wolfpack.json",
  /** Oldest Claude Code version with channel plugins and managed-settings drop-ins. */
  minimumClaudeVersion: "2.1.319",
  /** Status files live here, relative to the wolfpack state directory (`WOLFPACK_DIR`). */
  statusDirectory: "wolfpack-tasks/claude",
  /** Worker gate files sit beside status files as `<sessionId><gateFileSuffix>`. */
  gateFileSuffix: ".gate.json",
});

/** Managed-settings drop-in directories per platform; other platforms are unsupported. */
export const CLAUDE_MANAGED_SETTINGS_DROP_IN_DIRECTORIES: Readonly<Partial<Record<NodeJS.Platform, string>>> =
  Object.freeze({
    darwin: "/Library/Application Support/ClaudeCode/managed-settings.d",
    linux: "/etc/claude-code/managed-settings.d",
  });

export interface ClaudeChannelDropIn {
  readonly channelsEnabled: true;
  readonly allowedChannelPlugins: readonly { readonly plugin: string; readonly marketplace: string }[];
}

/** The only content wolfpack writes to its drop-in. */
export const CLAUDE_CHANNEL_DROP_IN: ClaudeChannelDropIn = Object.freeze({
  channelsEnabled: true,
  allowedChannelPlugins: Object.freeze([
    Object.freeze({ plugin: CLAUDE_INTEGRATION.plugin, marketplace: CLAUDE_INTEGRATION.marketplace }),
  ]),
});

/** The drop-in file content: stable JSON with a trailing newline, compared byte-for-byte on re-runs. */
export function claudeChannelDropInContent(): string {
  return `${JSON.stringify(CLAUDE_CHANNEL_DROP_IN, null, 2)}\n`;
}

/** The drop-in directory for `platform`, or undefined when the platform is unsupported. */
export function claudeManagedSettingsDropInDirectory(platform: NodeJS.Platform = process.platform): string | undefined {
  return CLAUDE_MANAGED_SETTINGS_DROP_IN_DIRECTORIES[platform];
}
