import { MAX_SESSION_NAME_LENGTH } from "../validation.js";
import { DuplicateSessionError } from "./backend.js";
import type { SessionLaunchOptions } from "./backend.js";
import { inferAgentKind } from "./session-identity.js";
import type { PublicSessionIdentity } from "./session-identity.js";

const MAX_CREATE_ATTEMPTS = 4;

export interface SessionCreateBackend {
  list(): Promise<string[]>;
  createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity>;
}

export interface TopLevelSessionSuccess {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
  readonly project: string;
  readonly harness: string;
}

interface CreateTopLevelSessionInput {
  readonly backend: SessionCreateBackend;
  readonly project: string;
  readonly projectDir: string;
  readonly command?: string;
  readonly initialPrompt?: string;
  readonly loadSettings: () => { agentCmd: string };
}

export function chooseTopLevelSessionName(
  project: string,
  existingNames: readonly string[],
): string {
  const base = project.replaceAll(".", "_");
  const existing = new Set(existingNames);
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? "" : `-${number}`;
    const candidate = `${base.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export async function createTopLevelSession(
  input: CreateTopLevelSessionInput,
): Promise<TopLevelSessionSuccess> {
  const configuredCommand = input.command ?? input.loadSettings().agentCmd;
  const harness = inferAgentKind(configuredCommand);
  const loadSettings = () => ({ agentCmd: configuredCommand });

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const session = chooseTopLevelSessionName(input.project, await input.backend.list());
    try {
      const identity = await input.backend.createSession(
        session,
        input.projectDir,
        input.command,
        loadSettings,
        {
          agentKind: harness,
          initialPrompt: input.initialPrompt,
        },
      );
      return {
        ok: true,
        session,
        sessionId: identity.wolfpackSessionId,
        project: input.project,
        harness,
      };
    } catch (error: unknown) {
      if (!(error instanceof DuplicateSessionError)) throw error;
      if (attempt + 1 >= MAX_CREATE_ATTEMPTS) throw error;
    }
  }

  throw new Error("unreachable session creation state");
}
