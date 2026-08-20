import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AGENT_KIND } from "./agent-kind.js";
import type { OpenableHarness } from "./agent-kind.js";

const VERSION_OUTPUT_MAX_CHARS = 160;
const VERSION_PROBE_TIMEOUT_MS = 2_000;

export interface ProviderDefinition {
  readonly id: OpenableHarness;
  readonly displayName: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly installGuidance: string;
  readonly loginCommand: string;
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: AGENT_KIND.CLAUDE,
    displayName: "Claude Code",
    command: AGENT_KIND.CLAUDE,
    versionArgs: ["--version"],
    installGuidance: "npm install -g @anthropic-ai/claude-code",
    loginCommand: AGENT_KIND.CLAUDE,
  },
  {
    id: AGENT_KIND.CODEX,
    displayName: "Codex",
    command: AGENT_KIND.CODEX,
    versionArgs: ["--version"],
    installGuidance: "npm install -g @openai/codex",
    loginCommand: `${AGENT_KIND.CODEX} login`,
  },
  {
    id: AGENT_KIND.GEMINI,
    displayName: "Gemini CLI",
    command: AGENT_KIND.GEMINI,
    versionArgs: ["--version"],
    installGuidance: "npm install -g @google/gemini-cli",
    loginCommand: AGENT_KIND.GEMINI,
  },
  {
    id: AGENT_KIND.CURSOR,
    displayName: "Cursor",
    command: AGENT_KIND.CURSOR,
    versionArgs: ["--version"],
    installGuidance: "Install from https://cursor.com/downloads, then add the cursor command to PATH",
    loginCommand: AGENT_KIND.CURSOR,
  },
  {
    id: AGENT_KIND.PI,
    displayName: "Pi",
    command: AGENT_KIND.PI,
    versionArgs: ["--version"],
    installGuidance: "npm install -g @mariozechner/pi-coding-agent",
    loginCommand: AGENT_KIND.PI,
  },
] as const;

export function getProviderDisplayName(providerId: OpenableHarness): string {
  const provider = PROVIDER_DEFINITIONS.find(({ id }) => id === providerId);
  if (!provider) throw new Error(`Missing provider definition for ${providerId}`);
  return provider.displayName;
}

export interface InstalledProviderReadiness {
  readonly id: OpenableHarness;
  readonly displayName: string;
  readonly command: string;
  readonly status: "installed";
  readonly executablePath: string;
  readonly version: string | null;
  readonly authStatus: "unknown";
  readonly loginCommand: string;
}

export interface MissingProviderReadiness {
  readonly id: OpenableHarness;
  readonly displayName: string;
  readonly command: string;
  readonly status: "missing";
  readonly installGuidance: string;
}

export type ProviderReadiness = InstalledProviderReadiness | MissingProviderReadiness;

export interface ProviderDetectionOptions {
  readonly path: string | undefined;
  readonly versionTimeoutMs?: number;
}

function findExecutable(command: string, pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing and non-executable PATH entries are ordinary probe results.
    }
  }
  return null;
}

export function detectInstalledProviderCommands(pathValue: string | undefined): OpenableHarness[] {
  return PROVIDER_DEFINITIONS
    .filter((provider) => findExecutable(provider.command, pathValue) !== null)
    .map((provider) => provider.id);
}

function readVersion(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executablePath, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .map((value) => value.replace(/[\u0000-\u001f\u007f]/g, "").trim())
        .find(Boolean);
      resolve(line ? line.slice(0, VERSION_OUTPUT_MAX_CHARS) : null);
    });
  });
}

export async function detectProviderReadiness(
  options: ProviderDetectionOptions,
): Promise<ProviderReadiness[]> {
  const timeoutMs = options.versionTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  return Promise.all(PROVIDER_DEFINITIONS.map(async (provider): Promise<ProviderReadiness> => {
    const executablePath = findExecutable(provider.command, options.path);
    if (!executablePath) {
      return {
        id: provider.id,
        displayName: provider.displayName,
        command: provider.command,
        status: "missing",
        installGuidance: provider.installGuidance,
      };
    }
    return {
      id: provider.id,
      displayName: provider.displayName,
      command: provider.command,
      status: "installed",
      executablePath,
      version: await readVersion(executablePath, provider.versionArgs, timeoutMs),
      authStatus: "unknown",
      loginCommand: provider.loginCommand,
    };
  }));
}
