/**
 * `wolfpack doctor` checks for agent integrations (Pi Tasks, Claude Code channels).
 * Every probe is read-only; fixes are printed commands, never run by `--fix`.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_KIND } from "../agent-kind.js";
import { CLAUDE_INTEGRATION, claudeManagedSettingsDropInDirectory } from "../claude-integration.js";
import { WOLFPACK_DIR, claudeTaskIntegrationEnabled } from "../config.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";
import {
  CLAUDE_MARKETPLACE_ADD_COMMAND,
  CLAUDE_PLUGIN_INSTALL_COMMAND,
  claudeConfigDirectory,
  claudeMarketplaceInstalled,
  claudePluginInstalled,
  claudeProviderOverride,
  claudeVersionMeetsMinimum,
  defaultClaudeSetupRunner,
  readJsonRecord,
  type ClaudeSetupRunner,
} from "./claude-integration-setup.js";
import type { CheckResult } from "./doctor.js";
import { PI_TASKS_MIGRATION_COMMANDS, findLegacyPiTasksSource, piAgentDirectory } from "./pi-integration.js";

const GROUP = "Integrations";

/** Warns when Pi still has the package under its pre-rename name. */
export function checkPiTasksPackage(agentDirectory: string = piAgentDirectory()): CheckResult[] {
  const legacySource = findLegacyPiTasksSource(agentDirectory);
  if (legacySource === undefined) return [];
  return [{
    name: "pi tasks package",
    group: GROUP,
    status: "warn",
    detail: `${legacySource} is installed under its old name`,
    fixHint: PI_TASKS_MIGRATION_COMMANDS.join(" && "),
  }];
}

export interface ClaudeIntegrationDoctorOptions {
  /** `claudeTaskIntegration` in the wolfpack config. */
  readonly enabled: boolean;
  /** `claude` is on PATH. */
  readonly claudeDetected: boolean;
  /** Runs only `claude --version`, non-interactively. */
  readonly run: ClaudeSetupRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly claudeConfigDirectory: string;
  /** Undefined on platforms without a known managed-settings drop-in directory. */
  readonly dropInDirectory: string | undefined;
  /** Directory of the plugin's per-session status files. */
  readonly statusDirectory: string;
  readonly pidAlive: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultClaudeIntegrationDoctorOptions(): ClaudeIntegrationDoctorOptions {
  return {
    enabled: claudeTaskIntegrationEnabled(),
    claudeDetected: detectInstalledProviderCommands(process.env.PATH).includes(AGENT_KIND.CLAUDE.id),
    run: defaultClaudeSetupRunner,
    env: process.env,
    claudeConfigDirectory: claudeConfigDirectory(),
    dropInDirectory: claudeManagedSettingsDropInDirectory(),
    statusDirectory: join(WOLFPACK_DIR, CLAUDE_INTEGRATION.statusDirectory),
    pidAlive: processAlive,
  };
}

const SETUP = "wolfpack setup";

function claudeResult(name: string, status: CheckResult["status"], detail: string, fixHint?: string): CheckResult {
  return { name, group: GROUP, status, detail, ...(fixHint !== undefined && { fixHint }) };
}

function allowsWolfpackChannel(value: unknown): boolean {
  return Array.isArray(value) && value.some(entry =>
    typeof entry === "object" && entry !== null
    && (entry as { plugin?: unknown }).plugin === CLAUDE_INTEGRATION.plugin
    && (entry as { marketplace?: unknown }).marketplace === CLAUDE_INTEGRATION.marketplace);
}

function checkClaudeVersion(options: ClaudeIntegrationDoctorOptions): CheckResult {
  const result = options.run(AGENT_KIND.CLAUDE.cmd, ["--version"], { interactive: false });
  const minimum = CLAUDE_INTEGRATION.minimumClaudeVersion;
  if (!result.ok) return claudeResult("claude version", "fail", `could not run ${AGENT_KIND.CLAUDE.cmd} --version`, `install Claude Code ${minimum} or newer`);
  const version = result.stdout.trim();
  return claudeVersionMeetsMinimum(version)
    ? claudeResult("claude version", "pass", version)
    : claudeResult("claude version", "fail", `${version || "unknown version"} is older than ${minimum}`, `update Claude Code to ${minimum} or newer`);
}

function checkClaudeProvider(options: ClaudeIntegrationDoctorOptions): CheckResult {
  const override = claudeProviderOverride(options.env);
  return override === undefined
    ? claudeResult("claude provider", "pass", "first-party provider")
    : claudeResult("claude provider", "fail", `${override} selects a provider without channel support`, `unset ${override} for wolfpack sessions`);
}

function checkClaudePlugin(options: ClaudeIntegrationDoctorOptions): CheckResult {
  if (claudePluginInstalled(options.claudeConfigDirectory)) {
    return claudeResult("claude plugin", "pass", `${CLAUDE_INTEGRATION.pluginSpec} installed in user scope`);
  }
  const commands = claudeMarketplaceInstalled(options.claudeConfigDirectory)
    ? [CLAUDE_PLUGIN_INSTALL_COMMAND]
    : [CLAUDE_MARKETPLACE_ADD_COMMAND, CLAUDE_PLUGIN_INSTALL_COMMAND];
  return claudeResult("claude plugin", "fail", `${CLAUDE_INTEGRATION.pluginSpec} is not installed in user scope`, commands.join(" && "));
}

function checkClaudeDropIn(dropInPath: string): CheckResult {
  if (!existsSync(dropInPath)) return claudeResult("claude channel drop-in", "fail", `${dropInPath} is missing`, SETUP);
  const settings = readJsonRecord(dropInPath);
  if (settings === undefined) return claudeResult("claude channel drop-in", "fail", `${dropInPath} is not a JSON object`, SETUP);
  if (settings.channelsEnabled !== true) return claudeResult("claude channel drop-in", "fail", `${dropInPath} does not set channelsEnabled to true`, SETUP);
  if (!allowsWolfpackChannel(settings.allowedChannelPlugins)) {
    return claudeResult("claude channel drop-in", "fail", `${dropInPath} does not allow the ${CLAUDE_INTEGRATION.channelSpec} channel`, SETUP);
  }
  return claudeResult("claude channel drop-in", "pass", dropInPath);
}

/**
 * Claude merges `managed-settings.json` and then `managed-settings.d/*.json` (non-hidden, alphabetical);
 * `allowedChannelPlugins` from one source replaces the others, and `channelsEnabled: false` disables channels.
 * MDM and server-managed sources are not inspected.
 */
function checkOtherManagedSources(dropInDirectory: string): CheckResult {
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(dropInDirectory)
      .filter(name => name.endsWith(".json") && !name.startsWith(".") && name !== CLAUDE_INTEGRATION.dropInFileName)
      .sort()
      .map(name => join(dropInDirectory, name));
  } catch { /* expected: the drop-in directory does not exist; the drop-in check reports it */ }
  const conflicts: string[] = [];
  const allowing: string[] = [];
  for (const path of [join(dirname(dropInDirectory), "managed-settings.json"), ...dropIns]) {
    const settings = readJsonRecord(path);
    if (settings === undefined) continue;
    if (settings.channelsEnabled === false) conflicts.push(`${path} sets channelsEnabled to false`);
    if (!Object.hasOwn(settings, "allowedChannelPlugins")) continue;
    if (allowsWolfpackChannel(settings.allowedChannelPlugins)) allowing.push(path);
    else conflicts.push(`${path} sets allowedChannelPlugins without ${CLAUDE_INTEGRATION.channelSpec}`);
  }
  if (conflicts.length === 0) {
    const note = allowing.length > 0 ? `; ${allowing.join(", ")} also allow it` : "";
    return claudeResult("claude channel allowlist", "pass", `no other managed-settings file blocks the channel${note}`);
  }
  return claudeResult(
    "claude channel allowlist",
    "warn",
    `${conflicts.join("; ")} (Claude may use this allowlist instead of wolfpack's; MDM and server-managed settings are not checked)`,
    "ask the administrator of that managed-settings file to allow the channel",
  );
}

interface ClaudeStatusFile {
  readonly sessionId: string;
  readonly pid: number;
  readonly wake: string;
  readonly protocolVersion: unknown;
}

function readClaudeStatusFiles(statusDirectory: string): { readonly files: ClaudeStatusFile[]; readonly unreadable: number } {
  let names: string[] = [];
  try {
    names = readdirSync(statusDirectory).filter(name => name.endsWith(".json")).sort();
  } catch { /* expected: no claude session has written a status file yet */ }
  const files: ClaudeStatusFile[] = [];
  let unreadable = 0;
  for (const name of names) {
    const status = readJsonRecord(join(statusDirectory, name));
    if (status === undefined || typeof status.sessionId !== "string" || typeof status.pid !== "number" || typeof status.wake !== "string") {
      unreadable++;
      continue;
    }
    files.push({ sessionId: status.sessionId, pid: status.pid, wake: status.wake, protocolVersion: status.protocolVersion });
  }
  return { files, unreadable };
}

function checkClaudeWake(options: ClaudeIntegrationDoctorOptions): CheckResult {
  const { files, unreadable } = readClaudeStatusFiles(options.statusDirectory);
  const live = files.filter(file => options.pidAlive(file.pid));
  const fallback = live.filter(file => file.wake !== "channel");
  const channel = live.length - fallback.length;
  const unreadableNote = unreadable > 0 ? `; ${unreadable} unreadable status file(s)` : "";
  if (fallback.length > 0) {
    const sessions = fallback.map(file => `${file.sessionId} (pid ${file.pid}, protocol ${String(file.protocolVersion ?? "unknown")})`);
    return claudeResult(
      "claude wake",
      "warn",
      `fallback wake: ${sessions.join(", ")}; ${channel} on channel wake${unreadableNote}`,
      `restart those sessions with --channels ${CLAUDE_INTEGRATION.channelSpec}`,
    );
  }
  const detail = live.length === 0 ? "no live claude sessions" : `${channel} on channel wake`;
  return claudeResult("claude wake", "pass", `${detail}${unreadableNote}`);
}

/** Read-only checks for the opt-in Claude task integration; only `claude --version` is run. */
export function checkClaudeTaskIntegration(options: ClaudeIntegrationDoctorOptions = defaultClaudeIntegrationDoctorOptions()): CheckResult[] {
  if (!options.claudeDetected) return [];
  if (!options.enabled) return [claudeResult("claude task integration", "pass", "off", `run ${SETUP} to enable it`)];
  const results = [checkClaudeVersion(options), checkClaudeProvider(options), checkClaudePlugin(options)];
  if (options.dropInDirectory === undefined) {
    results.push(claudeResult("claude channel drop-in", "fail", `${process.platform} has no supported managed-settings drop-in directory`));
  } else {
    results.push(checkClaudeDropIn(join(options.dropInDirectory, CLAUDE_INTEGRATION.dropInFileName)));
    results.push(checkOtherManagedSources(options.dropInDirectory));
  }
  results.push(checkClaudeWake(options));
  return results;
}
