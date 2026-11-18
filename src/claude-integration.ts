import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** A JSON object from `path`; a missing, unreadable, malformed or non-object file gives undefined. */
export function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { /* expected: the file does not exist, or it is malformed */
    return undefined;
  }
}

/** True when an `allowedChannelPlugins` value contains the wolfpack-tasks plugin. */
export function allowsWolfpackChannel(value: unknown): boolean {
  return Array.isArray(value) && value.some(entry =>
    typeof entry === "object" && entry !== null
    && (entry as { plugin?: unknown }).plugin === CLAUDE_INTEGRATION.plugin
    && (entry as { marketplace?: unknown }).marketplace === CLAUDE_INTEGRATION.marketplace);
}

/** Why the drop-in at `dropInPath` does not grant the channel, or undefined when it does. */
export function claudeChannelDropInProblem(dropInPath: string): string | undefined {
  if (!existsSync(dropInPath)) return `${dropInPath} is missing`;
  const settings = readJsonRecord(dropInPath);
  if (settings === undefined) return `${dropInPath} is not a JSON object`;
  if (settings.channelsEnabled !== true) return `${dropInPath} does not set channelsEnabled to true`;
  if (!allowsWolfpackChannel(settings.allowedChannelPlugins)) {
    return `${dropInPath} does not allow the ${CLAUDE_INTEGRATION.channelSpec} channel`;
  }
  return undefined;
}

/** A Claude task-worker request while the flag is off: a non-retryable precondition that setup fixes. */
export const CLAUDE_TASK_INTEGRATION_OFF_ERROR =
  "Claude task workers need claudeTaskIntegration in ~/.wolfpack/config.json; run wolfpack setup to enable the Claude task integration";

/** The integration is effectively on, or off with the public error that names the fix. */
export type ClaudeTaskIntegrationGate =
  | { readonly on: true }
  | { readonly on: false; readonly error: string };

/**
 * The integration is on only while the `claudeTaskIntegration` flag is set and the current managed
 * drop-in grants the channel: without the drop-in, the integration stays off (no degraded launch).
 */
export function claudeTaskIntegrationGate(flag: boolean, dropInDirectory: string | undefined): ClaudeTaskIntegrationGate {
  if (!flag) return { on: false, error: CLAUDE_TASK_INTEGRATION_OFF_ERROR };
  if (dropInDirectory === undefined) {
    return { on: false, error: `the Claude task integration needs a managed-settings drop-in, but ${process.platform} has no supported managed-settings drop-in directory` };
  }
  const problem = claudeChannelDropInProblem(join(dropInDirectory, CLAUDE_INTEGRATION.dropInFileName));
  return problem === undefined
    ? { on: true }
    : { on: false, error: `the Claude task integration is off because ${problem}; run wolfpack setup to repair it and wolfpack doctor to check it` };
}

export interface ClaudeManagedSettingsDropIn {
  readonly directory: string | undefined;
}

/** The drop-in directory that the effective gate reads. */
export function activeClaudeManagedSettingsDropInDirectory(override?: ClaudeManagedSettingsDropIn): string | undefined {
  return override !== undefined ? override.directory : claudeManagedSettingsDropInDirectory();
}
