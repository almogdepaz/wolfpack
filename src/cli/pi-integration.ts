import { execFileSync } from "node:child_process";
import { AGENT_KIND } from "../agent-kind.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";

export const PI_INTEGRATION_PACKAGES = ["npm:@sgtbeatdown/pi-tasks"] as const;

export type PiIntegrationSetupMode = "hidden" | "prompt" | "guidance";

export function piIntegrationDisclosureLines(): readonly string[] {
  return [
    "  - Wolfpack skill: Install wolfpack-tailnet-control manually from the Wolfpack repository.",
    "  - Pi Tasks: adds agent_task_* tools and their delegation skill.",
    "  Command Pi will run:",
    ...PI_INTEGRATION_PACKAGES.map((source) => `    pi install ${source}`),
    "  Skills and extensions can execute commands with your user permissions. Review before accepting.",
  ];
}

export interface PiIntegrationInstallOptions {
  readonly pathValue: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface InstalledPiIntegration {
  readonly status: "installed";
  readonly installedSources: readonly string[];
}

export interface FailedPiIntegrationInstall {
  readonly status: "failed";
  readonly installedSources: readonly string[];
  readonly failedSource: string;
  readonly retryCommand: string;
}

export type PiIntegrationInstallResult = InstalledPiIntegration | FailedPiIntegrationInstall;

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

export function installPiIntegration(
  options: PiIntegrationInstallOptions,
): PiIntegrationInstallResult {
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
        status: "failed",
        installedSources,
        failedSource: source,
        retryCommand: `pi install ${source}`,
      };
    }
  }

  return { status: "installed", installedSources };
}
