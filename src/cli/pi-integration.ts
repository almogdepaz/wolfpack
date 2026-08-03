import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_KIND } from "../agent-kind.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";
import { WOLFPACK_PI_CONTROL_SKILL } from "./pi-skill.js";

export const PI_INTEGRATION_PACKAGES = ["npm:@sgtbeatdown/pi-tasks"] as const;
export const PI_CONTROL_SKILL_NAME = "wolfpack-tailnet-control";

export type PiIntegrationSetupMode = "hidden" | "prompt" | "guidance";

export function piIntegrationDisclosureLines(): readonly string[] {
  return [
    "  - Wolfpack skill: installs wolfpack-tailnet-control into Pi.",
    "  - Pi Tasks: adds agent_task_* tools and their delegation skill.",
    "  Wolfpack will install the skill, then Pi will run:",
    ...PI_INTEGRATION_PACKAGES.map((source) => `    pi install ${source}`),
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
  const hasPi = detectInstalledProviderCommands(pathValue).includes(AGENT_KIND.PI);
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
    writeFileSync(join(skillPath, "SKILL.md"), WOLFPACK_PI_CONTROL_SKILL);
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
      execFileSync("pi", ["install", source], {
        env,
        stdio: "inherit",
      });
      installedSources.push(source);
    } catch {
      return {
        status: "extension_failed",
        installedSources,
        failedSource: source,
        retryCommand: `pi install ${source}`,
      };
    }
  }

  return { status: "installed", installedSources };
}
