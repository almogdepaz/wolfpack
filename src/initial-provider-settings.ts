import { writeFileSync } from "node:fs";
import { AGENT_KIND } from "./agent-kind.js";
import { detectInstalledProviderCommands } from "./provider-readiness.js";

export interface InitialProviderSettings {
  readonly agentCmd: typeof AGENT_KIND.SHELL;
  readonly cmds: ReadonlyArray<{
    readonly cmd: string;
    readonly enabled: true;
  }>;
}

export interface InitialProviderSettingsOptions {
  readonly settingsPath: string;
  readonly pathValue: string | undefined;
}

export function initializeProviderSettingsFile(
  options: InitialProviderSettingsOptions,
): InitialProviderSettings | null {
  const settings: InitialProviderSettings = {
    agentCmd: AGENT_KIND.SHELL,
    cmds: [
      { cmd: AGENT_KIND.SHELL, enabled: true },
      ...detectInstalledProviderCommands(options.pathValue).map(cmd => ({
        cmd,
        enabled: true as const,
      })),
    ],
  };

  try {
    writeFileSync(options.settingsPath, JSON.stringify(settings, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return settings;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}
