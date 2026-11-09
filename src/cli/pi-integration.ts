import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_KIND } from "../agent-kind.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";
import { sleepSync } from "./config.js";
import { WOLFPACK_PI_CONTROL_SKILL_FILES } from "./pi-skill.js";

export const PI_TASKS_PACKAGE = "npm:@sgtbeatdown/wolfpack-tasks";
/** The package's name before the Claude integration; setup and doctor migrate it to `PI_TASKS_PACKAGE`. */
export const LEGACY_PI_TASKS_PACKAGE = "npm:@sgtbeatdown/pi-tasks";
export const PI_INTEGRATION_PACKAGES = [PI_TASKS_PACKAGE] as const;
const PI_CONTROL_SKILL_NAME = "wolfpack-tailnet-control";
const PI_INSTALL_COMMAND_PREFIX = `${AGENT_KIND.PI.cmd} install`;
const PI_REMOVE_COMMAND_PREFIX = `${AGENT_KIND.PI.cmd} remove`;

/** Pi's user-scope agent directory: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`. */
export function piAgentDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** The commands that replace the legacy package, in order. */
export const PI_TASKS_MIGRATION_COMMANDS = [
  `${PI_REMOVE_COMMAND_PREFIX} ${LEGACY_PI_TASKS_PACKAGE}`,
  `${PI_INSTALL_COMMAND_PREFIX} ${PI_TASKS_PACKAGE}`,
] as const;

/** Pi identifies npm packages by name and ignores a version suffix, so match both forms. */
function isLegacyPiTasksSource(source: string): boolean {
  return source === LEGACY_PI_TASKS_PACKAGE || source.startsWith(`${LEGACY_PI_TASKS_PACKAGE}@`);
}

function isPiTasksSource(source: string): boolean {
  return source === PI_TASKS_PACKAGE || source.startsWith(`${PI_TASKS_PACKAGE}@`);
}

/** The legacy package's settings entry: its source and the resource filters of an object entry. */
export interface LegacyPiTasksEntry {
  readonly source: string;
  /** Every key of an object entry except `source` (`skills`, `extensions`, ...); empty for a string entry. */
  readonly filters: Readonly<Record<string, unknown>>;
}

function piSettingsPath(agentDirectory: string): string {
  return join(agentDirectory, "settings.json");
}

/** Pi's user settings object; a missing, unreadable or non-object file gives undefined. */
function readPiSettings(agentDirectory: string): Record<string, unknown> | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(piSettingsPath(agentDirectory), "utf8"));
  } catch {
    return undefined;
  }
  return typeof settings === "object" && settings !== null && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : undefined;
}

function packageEntrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

/**
 * Reads Pi's user settings (`<agentDir>/settings.json`, `packages`) and returns the legacy
 * package entry when it is installed. A missing or unreadable file means not installed.
 */
export function findLegacyPiTasksEntry(agentDirectory: string = piAgentDirectory()): LegacyPiTasksEntry | undefined {
  const packages = readPiSettings(agentDirectory)?.packages;
  if (!Array.isArray(packages)) return undefined;
  for (const entry of packages) {
    const source = packageEntrySource(entry);
    if (source === undefined || !isLegacyPiTasksSource(source)) continue;
    if (typeof entry === "string") return { source, filters: {} };
    const { source: _source, ...filters } = entry as Record<string, unknown>;
    return { source, filters };
  }
  return undefined;
}

export function findLegacyPiTasksSource(agentDirectory: string = piAgentDirectory()): string | undefined {
  return findLegacyPiTasksEntry(agentDirectory)?.source;
}

/** The delegation skill was renamed with the package; `!`, `+` and `-` filter prefixes are kept. */
const LEGACY_DELEGATION_SKILL_FILTER = /^([!+-]?)skills\/wolfpack-pi-task-delegation(?=\/|$)/;
const DELEGATION_SKILL_FILTER_REPLACEMENT = "$1skills/wolfpack-task-delegation";

/** The legacy filters for the new package: only skill paths of the renamed delegation skill change. */
function migratedPiTasksFilters(filters: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const skills = filters.skills;
  if (!Array.isArray(skills)) return { ...filters };
  return {
    ...filters,
    skills: skills.map((pattern: unknown) => (
      typeof pattern === "string" ? pattern.replace(LEGACY_DELEGATION_SKILL_FILTER, DELEGATION_SKILL_FILTER_REPLACEMENT) : pattern
    )),
  };
}

/**
 * Pi guards settings.json with proper-lockfile (`lockSync(path, { realpath: false })`): the lock is
 * the directory `<path>.lock`, and a lock whose mtime is older than proper-lockfile's default stale
 * time is abandoned. This is the same protocol without the dependency.
 */
const PI_SETTINGS_LOCK_STALE_MS = 10_000;
/** Pi itself waits ~200 ms; a migration is rare, so it waits longer before it reports the hint. */
const PI_SETTINGS_LOCK_WAIT_MS = 1_000;
const PI_SETTINGS_LOCK_RETRY_MS = 20;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** The lock directory this process created: its identity and when its lease started or was last refreshed. */
interface PiSettingsLease {
  readonly lockPath: string;
  readonly dev: number;
  readonly ino: number;
  refreshedAt: number;
}

function sameDirectory(lease: PiSettingsLease): boolean {
  try {
    const stats = statSync(lease.lockPath);
    return stats.dev === lease.dev && stats.ino === lease.ino;
  } catch {
    return false;
  }
}

/** Creates `<path>.lock`; a stale lock is removed once. Returns undefined when the lock stays held or mkdir fails. */
function tryAcquirePiSettingsLock(lockPath: string): PiSettingsLease | undefined {
  for (let staleCheck = true; ; staleCheck = false) {
    try {
      const acquiredAt = Date.now();
      mkdirSync(lockPath);
      const { dev, ino } = statSync(lockPath);
      return { lockPath, dev, ino, refreshedAt: acquiredAt };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return undefined;
    }
    if (!staleCheck) return undefined;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      // The holder released it between mkdir and stat.
      if (errorCode(error) === "ENOENT") continue;
      return undefined;
    }
    if (mtimeMs >= Date.now() - PI_SETTINGS_LOCK_STALE_MS) return undefined;
    try {
      rmdirSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined;
    }
  }
}

/**
 * Call right before the write. False when the lease is compromised: the directory at the lock path
 * is not the one this process created, or the lease is old enough that another client may take it
 * as stale. Otherwise it refreshes the lock's mtime, as proper-lockfile's update does.
 *
 * Residual window (proper-lockfile has the same limit): a client can still take the lock between
 * this check and the end of the write if the write itself takes longer than the stale time. The
 * identity check also cannot tell a successor whose directory reuses this directory's inode.
 */
function confirmPiSettingsLease(lease: PiSettingsLease): boolean {
  const now = Date.now();
  if (now - lease.refreshedAt >= PI_SETTINGS_LOCK_STALE_MS || !sameDirectory(lease)) return false;
  try {
    const seconds = now / 1000;
    utimesSync(lease.lockPath, seconds, seconds);
  } catch {
    return false;
  }
  lease.refreshedAt = now;
  return true;
}

/** Removes the lock only while it is still this process's directory; false when ownership was lost. */
function releasePiSettingsLock(lease: PiSettingsLease): boolean {
  if (!sameDirectory(lease)) return false;
  try {
    rmdirSync(lease.lockPath);
  } catch {
    // The write already finished under the lease; a lock left behind becomes stale for other clients.
  }
  return true;
}

/**
 * Runs `update` while holding Pi's settings lock; false when the lock is not acquired in the retry
 * bound, when `update` fails, or when the lock is no longer this process's at release. `update`
 * must call `confirmLease` right before it writes and give up when it returns false.
 */
function withPiSettingsLock(settingsPath: string, update: (confirmLease: () => boolean) => boolean): boolean {
  const lockPath = `${settingsPath}.lock`;
  const deadline = Date.now() + PI_SETTINGS_LOCK_WAIT_MS;
  let lease = tryAcquirePiSettingsLock(lockPath);
  while (lease === undefined) {
    if (Date.now() >= deadline) return false;
    sleepSync(PI_SETTINGS_LOCK_RETRY_MS);
    lease = tryAcquirePiSettingsLock(lockPath);
  }
  const owned = lease;
  let updated = false;
  try {
    updated = update(() => confirmPiSettingsLease(owned));
  } finally {
    // Never remove a lock another client took; losing it before release also fails the update.
    if (!releasePiSettingsLock(owned)) updated = false;
  }
  return updated;
}

/**
 * Puts `filters` on the new package's entry, which `pi install` wrote as a plain source. Under Pi's
 * settings lock it re-reads the file and changes only that entry, so a concurrent Pi write is kept.
 * Returns false when the lock is held or lost before the write, the settings or the entry are missing,
 * or the write fails.
 */
function restorePiTasksFilters(agentDirectory: string, filters: Readonly<Record<string, unknown>>): boolean {
  const settingsPath = piSettingsPath(agentDirectory);
  if (!existsSync(settingsPath)) return false;
  return withPiSettingsLock(settingsPath, (confirmLease) => {
    const settings = readPiSettings(agentDirectory);
    const packages = settings?.packages;
    if (settings === undefined || !Array.isArray(packages)) return false;
    const index = packages.findIndex((entry: unknown) => {
      const source = packageEntrySource(entry);
      return source !== undefined && isPiTasksSource(source);
    });
    if (index === -1) return false;
    const entry: unknown = packages[index];
    const current = typeof entry === "string" ? { source: entry } : entry as Record<string, unknown>;
    const nextPackages = [...packages];
    nextPackages[index] = { ...current, ...filters };
    if (!confirmLease()) return false;
    try {
      writeFileSync(settingsPath, `${JSON.stringify({ ...settings, packages: nextPackages }, null, 2)}\n`);
    } catch {
      return false;
    }
    return true;
  });
}

export function piTasksMigrationDisclosureLines(
  legacySource: string,
  legacyFilters: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  return [
    `  Pi Tasks is now published as ${PI_TASKS_PACKAGE}; ${legacySource} is installed.`,
    "  Pi will run:",
    ...PI_TASKS_MIGRATION_COMMANDS.map((command) => `    ${command}`),
    ...(Object.keys(legacyFilters).length > 0
      ? ["  Wolfpack will then move the old entry's resource filters to the new entry in Pi's settings.json."]
      : []),
    "  Extensions can execute commands with your user permissions. Review before accepting.",
  ];
}

/** A package entry the user must put in Pi's settings by hand, because the migration could not. */
export interface PiTasksRestoreHint {
  readonly settingsPath: string;
  readonly restoreEntry: Readonly<Record<string, unknown>>;
}

/** After a failed install, the user runs the retry commands first; `pi install` then writes the entry to replace. */
export function piTasksRestoreHintLines(hint: PiTasksRestoreHint): readonly string[] {
  return [
    `  Pi Tasks resource filters were not kept. Replace the wolfpack-tasks entry in packages in ${hint.settingsPath} with:`,
    `    ${JSON.stringify(hint.restoreEntry)}`,
  ];
}

export type PiTasksMigrationResult =
  | { readonly status: "migrated" }
  | ({ readonly status: "filters_not_restored" } & PiTasksRestoreHint)
  | ({
    readonly status: "failed";
    readonly failedCommand: string;
    readonly retryCommands: readonly string[];
  } & Partial<PiTasksRestoreHint>);

/**
 * Removes the legacy package, then installs the renamed one; stops at the first failure.
 * The legacy entry's resource filters (a user's skill overlay, for example) move to the new entry.
 */
export function migratePiTasksPackage(options: {
  readonly pathValue: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): PiTasksMigrationResult {
  const env = { ...process.env, ...options.env, PATH: options.pathValue };
  const agentDirectory = piAgentDirectory(env);
  const legacyFilters = findLegacyPiTasksEntry(agentDirectory)?.filters ?? {};
  const filters = migratedPiTasksFilters(legacyFilters);
  const restoreHint: PiTasksRestoreHint | undefined = Object.keys(filters).length === 0
    ? undefined
    : { settingsPath: piSettingsPath(agentDirectory), restoreEntry: { source: PI_TASKS_PACKAGE, ...filters } };
  const steps = [
    ["remove", LEGACY_PI_TASKS_PACKAGE],
    ["install", PI_TASKS_PACKAGE],
  ] as const;
  for (const [index, args] of steps.entries()) {
    try {
      execFileSync(AGENT_KIND.PI.cmd, [...args], { env, stdio: "inherit" });
    } catch {
      return {
        status: "failed",
        failedCommand: PI_TASKS_MIGRATION_COMMANDS[index] ?? args.join(" "),
        retryCommands: PI_TASKS_MIGRATION_COMMANDS.slice(index),
        // Once the legacy entry is removed, its filters exist only in this hint.
        ...(index > 0 && restoreHint),
      };
    }
  }
  if (restoreHint !== undefined && !restorePiTasksFilters(agentDirectory, filters)) {
    return { status: "filters_not_restored", ...restoreHint };
  }
  return { status: "migrated" };
}

export type PiIntegrationSetupMode = "hidden" | "prompt" | "guidance";

export function piIntegrationDisclosureLines(): readonly string[] {
  return [
    "  - Wolfpack skill: installs wolfpack-tailnet-control into Pi.",
    "  - Pi Tasks: adds agent_task_* tools and their delegation skill.",
    "  Wolfpack will install the skill, then Pi will run:",
    ...PI_INTEGRATION_PACKAGES.map((source) => `    ${PI_INSTALL_COMMAND_PREFIX} ${source}`),
    "  Skills and extensions can execute commands with your user permissions. Review before accepting.",
  ];
}

export interface PiIntegrationInstallOptions {
  readonly pathValue: string | undefined;
  readonly piAgentDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface InstalledPiIntegration {
  readonly status: "installed";
  readonly installedSources: readonly string[];
}

export interface ExistingPiSkill {
  readonly status: "skill_exists";
  readonly skillPath: string;
}

export interface FailedPiSkillInstall {
  readonly status: "skill_write_failed";
  readonly skillPath: string;
  readonly canRetry: boolean;
}

export interface FailedPiExtensionInstall {
  readonly status: "extension_failed";
  readonly installedSources: readonly string[];
  readonly failedSource: string;
  readonly retryCommand: string;
}

export type PiIntegrationInstallResult =
  | InstalledPiIntegration
  | ExistingPiSkill
  | FailedPiSkillInstall
  | FailedPiExtensionInstall;

export function planPiIntegrationSetup(
  pathValue: string | undefined,
  interactive: boolean,
): PiIntegrationSetupMode {
  const hasPi = detectInstalledProviderCommands(pathValue).includes(AGENT_KIND.PI.id);
  if (!hasPi) return "hidden";
  return interactive ? "prompt" : "guidance";
}

export function acceptsPiIntegrationInstall(answer: string): boolean {
  return answer.toLowerCase() === "y";
}

function piControlSkillPath(piAgentDirectory: string | undefined): string {
  return join(
    piAgentDirectory ?? join(homedir(), ".pi", "agent"),
    "skills",
    PI_CONTROL_SKILL_NAME,
  );
}

function installWolfpackPiSkill(skillPath: string): ExistingPiSkill | FailedPiSkillInstall | undefined {
  if (existsSync(skillPath)) {
    return { status: "skill_exists", skillPath };
  }

  let createdSkillDirectory = false;
  try {
    mkdirSync(dirname(skillPath), { recursive: true });
    mkdirSync(skillPath);
    createdSkillDirectory = true;
    for (const { filename, content } of WOLFPACK_PI_CONTROL_SKILL_FILES) {
      writeFileSync(join(skillPath, filename), content);
    }
  } catch {
    let canRetry = true;
    if (createdSkillDirectory) {
      try {
        rmSync(skillPath, { recursive: true, force: true });
      } catch {
        canRetry = false;
      }
    }
    return { status: "skill_write_failed", skillPath, canRetry };
  }
}

export function installPiIntegration(
  options: PiIntegrationInstallOptions,
): PiIntegrationInstallResult {
  const skillPath = piControlSkillPath(options.piAgentDirectory);
  const skillFailure = installWolfpackPiSkill(skillPath);
  if (skillFailure) return skillFailure;

  const installedSources: string[] = [];
  const env = {
    ...process.env,
    ...options.env,
    PATH: options.pathValue,
  };

  for (const source of PI_INTEGRATION_PACKAGES) {
    try {
      execFileSync(AGENT_KIND.PI.cmd, ["install", source], {
        env,
        stdio: "inherit",
      });
      installedSources.push(source);
    } catch {
      return {
        status: "extension_failed",
        installedSources,
        failedSource: source,
        retryCommand: `${PI_INSTALL_COMMAND_PREFIX} ${source}`,
      };
    }
  }

  return { status: "installed", installedSources };
}
