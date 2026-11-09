/**
 * Opt-in setup for the Claude task integration: the wolfpack-tasks Claude Code plugin plus a machine-wide
 * managed-settings drop-in that allows its channel. Every external command goes through an injectable runner.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { coerce, gte } from "semver";
import { AGENT_KIND } from "../agent-kind.js";
import { CLAUDE_INTEGRATION, claudeChannelDropInContent } from "../claude-integration.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";

export interface ClaudeCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * `interactive: true` inherits the terminal so the user sees plugin output and can answer a sudo password
 * prompt; `interactive: false` captures stdout.
 */
export type ClaudeSetupRunner = (
  file: string,
  args: readonly string[],
  options: { readonly interactive: boolean },
) => ClaudeCommandResult;

const NON_INTERACTIVE_TIMEOUT_MS = 15_000;

export const defaultClaudeSetupRunner: ClaudeSetupRunner = (file, args, options) => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    // captured probes (`claude --version`) must not hang setup or doctor; interactive steps may wait for sudo
    ...(!options.interactive && { timeout: NON_INTERACTIVE_TIMEOUT_MS }),
  });
  return { ok: result.error === undefined && result.status === 0, stdout: result.stdout ?? "" };
};

/** Claude Code environment variables that select a provider other than Anthropic's first-party API. */
export const CLAUDE_THIRD_PARTY_PROVIDER_ENV = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

const CLAUDE = AGENT_KIND.CLAUDE.cmd;
const MARKETPLACE_ADD_ARGS = ["plugin", "marketplace", "add", CLAUDE_INTEGRATION.marketplaceSource] as const;
const PLUGIN_INSTALL_ARGS = ["plugin", "install", CLAUDE_INTEGRATION.pluginSpec] as const;
const RERUN_SETUP = "wolfpack setup";

/** Printed commands that add the marketplace and install the plugin, in order. */
export const CLAUDE_MARKETPLACE_ADD_COMMAND = [CLAUDE, ...MARKETPLACE_ADD_ARGS].join(" ");
export const CLAUDE_PLUGIN_INSTALL_COMMAND = [CLAUDE, ...PLUGIN_INSTALL_ARGS].join(" ");

function commandLine(file: string, args: readonly string[]): string {
  return [file, ...args].join(" ");
}

/** POSIX single-quoting for a printed command; nothing here is passed to a shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type ClaudeIntegrationSetupMode = "hidden" | "prompt" | "guidance";

export function planClaudeIntegrationSetup(pathValue: string | undefined, interactive: boolean): ClaudeIntegrationSetupMode {
  if (!detectInstalledProviderCommands(pathValue).includes(AGENT_KIND.CLAUDE.id)) return "hidden";
  return interactive ? "prompt" : "guidance";
}

export function acceptsClaudeIntegrationPrompt(answer: string): boolean {
  return answer.toLowerCase() === "y";
}

export function claudeIntegrationDisclosureLines(dropInDirectory: string | undefined): readonly string[] {
  const dropInPath = dropInDirectory === undefined
    ? "(unsupported platform)"
    : join(dropInDirectory, CLAUDE_INTEGRATION.dropInFileName);
  return [
    `  - Installs the ${CLAUDE_INTEGRATION.plugin} Claude Code plugin into Claude's user scope. Claude will run:`,
    `    ${commandLine(CLAUDE, MARKETPLACE_ADD_ARGS)}`,
    `    ${commandLine(CLAUDE, PLUGIN_INSTALL_ARGS)}`,
    `  - Writes a machine-wide managed-settings drop-in with sudo: ${dropInPath}`,
    `    It sets channelsEnabled and allowedChannelPlugins (${CLAUDE_INTEGRATION.pluginSpec} only).`,
    "    This allowedChannelPlugins replaces any lower-precedence allowlist. The highest-precedence managed",
    "    source that sets allowedChannelPlugins wins, so another managed source can block it.",
    `  - Wolfpack then launches claude sessions with --channels ${CLAUDE_INTEGRATION.channelSpec}.`,
    "  Plugins can execute commands with your user permissions. Review before accepting.",
  ];
}

export function claudeIntegrationDisableLines(dropInDirectory: string | undefined): readonly string[] {
  const lines = ["  Wolfpack no longer launches claude sessions with the wolfpack-tasks channel."];
  if (dropInDirectory !== undefined) {
    lines.push(
      "  To remove the managed-settings drop-in, run:",
      `    sudo rm ${shellQuote(join(dropInDirectory, CLAUDE_INTEGRATION.dropInFileName))}`,
    );
  }
  lines.push(
    "  To remove the plugin, run:",
    `    ${commandLine(CLAUDE, ["plugin", "uninstall", CLAUDE_INTEGRATION.pluginSpec])}`,
  );
  return lines;
}

/** Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeConfigDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeVersionMeetsMinimum(versionOutput: string): boolean {
  const version = coerce(versionOutput);
  return version !== null && gte(version, CLAUDE_INTEGRATION.minimumClaudeVersion);
}

function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** The first set third-party provider variable, or undefined for the first-party provider. */
export function claudeProviderOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return CLAUDE_THIRD_PARTY_PROVIDER_ENV.find(name => truthyEnv(env[name]));
}

/** A JSON object file, or undefined when it is missing, malformed or not an object. */
export function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { /* expected: claude has not written this state file, or it is malformed */
    return undefined;
  }
}

/** Reads `plugins/known_marketplaces.json` (keyed by marketplace name). */
export function claudeMarketplaceInstalled(configDirectory: string): boolean {
  const marketplaces = readJsonRecord(join(configDirectory, "plugins", "known_marketplaces.json"));
  return marketplaces !== undefined && Object.hasOwn(marketplaces, CLAUDE_INTEGRATION.marketplace);
}

/** Reads `plugins/installed_plugins.json` (`plugins["plugin@marketplace"]` is a list of scoped installs). */
export function claudePluginInstalled(configDirectory: string): boolean {
  const installed = readJsonRecord(join(configDirectory, "plugins", "installed_plugins.json"));
  const plugins = installed?.plugins;
  if (typeof plugins !== "object" || plugins === null) return false;
  const entries: unknown = (plugins as Record<string, unknown>)[CLAUDE_INTEGRATION.pluginSpec];
  return Array.isArray(entries) && entries.some(entry =>
    typeof entry === "object" && entry !== null && (entry as { scope?: unknown }).scope === "user");
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch { /* expected: the drop-in does not exist yet */
    return undefined;
  }
}

export interface ClaudeIntegrationEnableOptions {
  readonly run: ClaudeSetupRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly claudeConfigDirectory: string;
  /** Undefined on unsupported platforms. */
  readonly dropInDirectory: string | undefined;
  /** Explicit confirmation before sudo writes the drop-in at this path. */
  readonly confirmDropIn: (dropInPath: string) => boolean;
  /** Progress lines, such as skipped steps. */
  readonly report: (line: string) => void;
}

export type ClaudeIntegrationEnableResult =
  | { readonly status: "enabled" }
  | {
    readonly status: "failed";
    readonly reason: string;
    /** The external command that failed, when one did. */
    readonly failedCommand?: string;
    readonly retry: string;
  };

type StepFailure = Extract<ClaudeIntegrationEnableResult, { status: "failed" }>;

function runStep(options: ClaudeIntegrationEnableOptions, file: string, args: readonly string[], reason: string): StepFailure | undefined {
  if (options.run(file, args, { interactive: true }).ok) return undefined;
  const command = commandLine(file, args);
  return { status: "failed", reason, failedCommand: command, retry: `${command}, then ${RERUN_SETUP}` };
}

function checkClaude(options: ClaudeIntegrationEnableOptions): StepFailure | undefined {
  const version = options.run(CLAUDE, ["--version"], { interactive: false });
  if (!version.ok) {
    return { status: "failed", reason: `could not run ${CLAUDE} --version`, failedCommand: `${CLAUDE} --version`, retry: `check that ${CLAUDE} runs, then ${RERUN_SETUP}` };
  }
  if (!claudeVersionMeetsMinimum(version.stdout)) {
    return {
      status: "failed",
      reason: `Claude Code ${version.stdout.trim() || "(unknown version)"} is older than ${CLAUDE_INTEGRATION.minimumClaudeVersion}; checked with ${CLAUDE} --version`,
      retry: `${CLAUDE} update, then ${RERUN_SETUP}`,
    };
  }
  const provider = claudeProviderOverride(options.env);
  if (provider !== undefined) {
    return {
      status: "failed",
      reason: `channels need Claude Code's first-party provider, but ${provider} is set`,
      retry: `unset ${provider}, then ${RERUN_SETUP}`,
    };
  }
  return undefined;
}

function installDropIn(options: ClaudeIntegrationEnableOptions): StepFailure | undefined {
  const directory = options.dropInDirectory;
  if (directory === undefined) {
    return { status: "failed", reason: `managed-settings drop-ins are not supported on platform ${process.platform}`, retry: "none on this platform" };
  }
  const dropInPath = join(directory, CLAUDE_INTEGRATION.dropInFileName);
  const content = claudeChannelDropInContent();
  if (readTextFile(dropInPath) === content) {
    options.report(`  Managed-settings drop-in already current: ${dropInPath}`);
    return undefined;
  }
  if (!options.confirmDropIn(dropInPath)) {
    return { status: "failed", reason: "the managed-settings drop-in was declined", retry: RERUN_SETUP };
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "wolfpack-claude-drop-in-"));
  try {
    const temporaryPath = join(temporaryDirectory, CLAUDE_INTEGRATION.dropInFileName);
    writeFileSync(temporaryPath, content, { mode: 0o644 });
    const failure = runStep(options, "sudo", ["mkdir", "-p", directory], `could not create ${directory}`)
      ?? runStep(options, "sudo", ["install", "-m", "0644", temporaryPath, dropInPath], `could not install the managed-settings drop-in ${dropInPath}`);
    if (failure) return failure;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (readTextFile(dropInPath) !== content) {
    return { status: "failed", reason: `the managed-settings drop-in ${dropInPath} does not have the expected content after install`, retry: RERUN_SETUP };
  }
  return undefined;
}

/**
 * Runs the opt-in steps in order and stops at the first failure. Satisfied steps are skipped, so re-runs are
 * idempotent. The caller persists the config flag only after `enabled`.
 */
export function enableClaudeTaskIntegration(options: ClaudeIntegrationEnableOptions): ClaudeIntegrationEnableResult {
  const claudeFailure = checkClaude(options);
  if (claudeFailure) return claudeFailure;

  if (claudeMarketplaceInstalled(options.claudeConfigDirectory)) {
    options.report(`  Claude marketplace ${CLAUDE_INTEGRATION.marketplace} already added.`);
  } else {
    const failure = runStep(options, CLAUDE, MARKETPLACE_ADD_ARGS, `could not add the ${CLAUDE_INTEGRATION.marketplace} marketplace`);
    if (failure) return failure;
  }

  if (claudePluginInstalled(options.claudeConfigDirectory)) {
    options.report(`  Claude plugin ${CLAUDE_INTEGRATION.pluginSpec} already installed.`);
  } else {
    const failure = runStep(options, CLAUDE, PLUGIN_INSTALL_ARGS, `could not install the ${CLAUDE_INTEGRATION.pluginSpec} plugin`);
    if (failure) return failure;
  }

  return installDropIn(options) ?? { status: "enabled" };
}
