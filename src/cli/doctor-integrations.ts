/**
 * `wolfpack doctor` checks for agent integrations (Pi Tasks, Claude Code channels).
 * Every probe is read-only; fixes are printed commands, never run by `--fix`.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_KIND } from "../agent-kind.js";
import {
  CLAUDE_INTEGRATION,
  allowsWolfpackChannel,
  claudeChannelDropInProblem,
  claudeManagedSettingsDropInDirectory,
} from "../claude-integration.js";
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
  const problem = claudeChannelDropInProblem(dropInPath);
  return problem === undefined
    ? claudeResult("claude channel drop-in", "pass", dropInPath)
    : claudeResult("claude channel drop-in", "fail", problem, SETUP);
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

/** The fields doctor reads from the plugin's status file (`src/claude/status-file.ts` in wolfpack-tasks). */
interface ClaudeStatusFile {
  readonly sessionId: string;
  readonly sessionName: string | undefined;
  readonly pid: number;
  readonly wake: string;
  readonly protocolVersion: unknown;
  readonly lastPointerAt: number | undefined;
  readonly lastInboxAt: number | undefined;
  readonly lastNudgeAt: number | undefined;
  readonly fallbackAt: number | undefined;
  readonly lastNudgeError: string | undefined;
  readonly statusFailures: number;
  readonly wakeStalledAt: number | undefined;
}

interface ClaudeStatusFiles {
  readonly files: ClaudeStatusFile[];
  /** Paths of status files that cannot be read or parsed, or that lack the identity fields. */
  readonly unreadable: string[];
  /** Why the status directory cannot be listed; a missing directory is not a problem. */
  readonly directoryError: string | undefined;
}

const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function readClaudeStatusFiles(statusDirectory: string): ClaudeStatusFiles {
  let names: string[] = [];
  let directoryError: string | undefined;
  try {
    names = readdirSync(statusDirectory).filter(name => name.endsWith(".json")).sort();
  } catch (error) {
    // A missing directory only means no claude session has written a status file yet.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      directoryError = `cannot read ${statusDirectory}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const files: ClaudeStatusFile[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    const path = join(statusDirectory, name);
    const status = readJsonRecord(path);
    if (status === undefined || typeof status.sessionId !== "string" || typeof status.pid !== "number" || typeof status.wake !== "string") {
      unreadable.push(path);
      continue;
    }
    files.push({
      sessionId: status.sessionId,
      sessionName: optionalString(status.sessionName),
      pid: status.pid,
      wake: status.wake,
      protocolVersion: status.protocolVersion,
      lastPointerAt: optionalNumber(status.lastPointerAt),
      lastInboxAt: optionalNumber(status.lastInboxAt),
      lastNudgeAt: optionalNumber(status.lastNudgeAt),
      fallbackAt: optionalNumber(status.fallbackAt),
      lastNudgeError: optionalString(status.lastNudgeError),
      statusFailures: optionalNumber(status.statusFailures) ?? 0,
      wakeStalledAt: optionalNumber(status.wakeStalledAt),
    });
  }
  return { files, unreadable, directoryError };
}

const isoTime = (ms: number | undefined): string => (ms === undefined ? "an unknown time" : new Date(ms).toISOString());
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

type ClaudeWakeProblemKind = "stalled" | "fallback" | "error";

/** Whether `lastNudgeError` is current: `uncertain` when it may belong to the outstanding pointer or to an earlier one. */
type NudgeErrorState = "current" | "uncertain" | undefined;

/**
 * The plugin never clears `lastNudgeError`, so doctor decides whether it is current. A nonzero exit
 * of the paste or submit command sets `lastNudgeAt` with the error; an inbox call after it means the
 * model got the task. A failed status check sets the error and `statusFailures`, which the next
 * pointer resets to 0, so a nonzero count belongs to the outstanding pointer (`lastPointerAt` later
 * than `lastInboxAt`). A thrown paste or submit sets only the error: while a pointer is outstanding,
 * the timestamps cannot tell that error from an earlier one, so it is `uncertain`. An inbox call
 * after the pointer acknowledges all of them. (`wakeStalledAt` needs no rule: the next inbox call clears it.)
 */
function nudgeErrorState(file: ClaudeStatusFile): NudgeErrorState {
  if (file.lastNudgeError === undefined) return undefined;
  if (file.lastInboxAt === undefined) return "current";
  if (file.lastNudgeAt !== undefined && file.lastInboxAt <= file.lastNudgeAt) return "current";
  if (file.lastPointerAt === undefined || file.lastPointerAt <= file.lastInboxAt) return undefined;
  return file.statusFailures > 0 ? "current" : "uncertain";
}

/** Why a live session's wake needs attention, or undefined when it is on channel wake without a current error. */
function claudeWakeProblem(file: ClaudeStatusFile): { readonly detail: string; readonly kinds: readonly ClaudeWakeProblemKind[] } | undefined {
  const label = `${file.sessionName ?? file.sessionId} (${file.sessionId}, pid ${file.pid})`;
  const fallback = file.wake !== "channel";
  const errorState = nudgeErrorState(file);
  const errorSubject = errorState === "uncertain"
    ? `last nudge error may belong to the outstanding pointer from ${isoTime(file.lastPointerAt)}`
    : "last nudge error";
  if (file.wakeStalledAt !== undefined) {
    const error = file.lastNudgeError ?? "no error recorded";
    return {
      kinds: fallback ? ["stalled", "fallback"] : ["stalled"],
      detail: `${label}: ${file.wake} wake stalled at ${isoTime(file.wakeStalledAt)} after ${plural(file.statusFailures, "status check")}: ${error}`,
    };
  }
  if (fallback) {
    const lastError = errorState !== undefined ? `, ${errorSubject}: ${file.lastNudgeError}` : "";
    return { kinds: ["fallback"], detail: `${label}: fallback wake since ${isoTime(file.fallbackAt)} (protocol ${String(file.protocolVersion ?? "unknown")})${lastError}` };
  }
  if (errorState !== undefined) {
    const retrying = file.statusFailures > 0 ? ` (${plural(file.statusFailures, "failed status check")})` : "";
    return { kinds: ["error"], detail: `${label}: ${errorSubject}: ${file.lastNudgeError}${retrying}` };
  }
  return undefined;
}

/**
 * Wake health per live Claude session from the plugin's status files. Channel wake counts as
 * delivered only after a pointer or inbox call; before that it is configured but unverified.
 */
function checkClaudeWake(options: ClaudeIntegrationDoctorOptions): CheckResult {
  const { files, unreadable, directoryError } = readClaudeStatusFiles(options.statusDirectory);
  const problems: string[] = [];
  const kinds = new Set<ClaudeWakeProblemKind>();
  let delivered = 0;
  let unverified = 0;
  for (const file of files.filter(status => options.pidAlive(status.pid))) {
    const problem = claudeWakeProblem(file);
    if (problem !== undefined) {
      problems.push(problem.detail);
      for (const kind of problem.kinds) kinds.add(kind);
    } else if (file.lastPointerAt !== undefined || file.lastInboxAt !== undefined) {
      delivered++;
    } else {
      unverified++;
    }
  }
  if (directoryError !== undefined) problems.push(directoryError);
  if (unreadable.length > 0) problems.push(`unreadable status files: ${unreadable.join(", ")}`);

  const summary: string[] = [];
  if (delivered > 0) summary.push(`${delivered} on channel wake with pointer or inbox activity`);
  if (unverified > 0) summary.push(`${unverified} channel configured, unverified (no pointer or inbox activity yet)`);
  if (problems.length === 0) {
    return claudeResult("claude wake", "pass", summary.length > 0 ? summary.join("; ") : "no live claude sessions");
  }
  const hints: string[] = [];
  if (kinds.has("fallback")) hints.push(`restart fallback sessions with --channels ${CLAUDE_INTEGRATION.channelSpec}`);
  if (kinds.has("stalled") || kinds.has("error")) {
    hints.push("check that the wolfpack server answers wolfpack session status <session-id> --json; the next inbox call clears a stall");
  }
  if (directoryError !== undefined || unreadable.length > 0) {
    hints.push(`check the permissions and content of ${options.statusDirectory}; remove status files of sessions that no longer run`);
  }
  return claudeResult("claude wake", "warn", [...problems, ...summary].join("; "), hints.join("; "));
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
