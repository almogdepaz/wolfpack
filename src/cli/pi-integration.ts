import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_KIND } from "../agent-kind.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";
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

/**
 * Reads Pi's user settings (`<agentDir>/settings.json`, `packages`) and returns the legacy
 * package source when it is installed. A missing or unreadable file means not installed.
 */
export function findLegacyPiTasksSource(agentDirectory: string = piAgentDirectory()): string | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(agentDirectory, "settings.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof settings !== "object" || settings === null) return undefined;
  const packages = (settings as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return undefined;
  for (const entry of packages) {
    const source = typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
        ? (entry as { source: string }).source
        : undefined;
    if (source !== undefined && isLegacyPiTasksSource(source)) return source;
  }
  return undefined;
}

export function piTasksMigrationDisclosureLines(legacySource: string): readonly string[] {
  return [
    `  Pi Tasks is now published as ${PI_TASKS_PACKAGE}; ${legacySource} is installed.`,
    "  Pi will run:",
    ...PI_TASKS_MIGRATION_COMMANDS.map((command) => `    ${command}`),
    "  Extensions can execute commands with your user permissions. Review before accepting.",
  ];
}

export type PiTasksMigrationResult =
  | { readonly status: "migrated" }
  | { readonly status: "failed"; readonly failedCommand: string; readonly retryCommands: readonly string[] };

/** Removes the legacy package, then installs the renamed one; stops at the first failure. */
export function migratePiTasksPackage(options: {
  readonly pathValue: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): PiTasksMigrationResult {
  const env = { ...process.env, ...options.env, PATH: options.pathValue };
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
      };
    }
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
