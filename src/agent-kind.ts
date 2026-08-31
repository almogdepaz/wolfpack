export interface AgentKindDefinition {
  readonly id: string;
  readonly cmd: string;
}

export const AGENT_KIND = {
  SHELL: { id: "shell", cmd: "shell" },
  PI: { id: "pi", cmd: "pi" },
  CLAUDE: { id: "claude", cmd: "claude" },
  CODEX: { id: "codex", cmd: "codex" },
  GEMINI: { id: "gemini", cmd: "gemini" },
  CURSOR: { id: "cursor", cmd: "agent" },
  UNKNOWN: { id: "unknown", cmd: "unknown" },
} as const satisfies Readonly<Record<string, AgentKindDefinition>>;

export const KNOWN_AGENT_KINDS = [
  AGENT_KIND.SHELL.id,
  AGENT_KIND.CLAUDE.id,
  AGENT_KIND.CODEX.id,
  AGENT_KIND.PI.id,
  AGENT_KIND.GEMINI.id,
  AGENT_KIND.CURSOR.id,
  AGENT_KIND.UNKNOWN.id,
] as const;

export type AgentKind = typeof KNOWN_AGENT_KINDS[number];

export const OPENABLE_HARNESSES = [
  AGENT_KIND.PI.id,
  AGENT_KIND.CLAUDE.id,
  AGENT_KIND.CODEX.id,
  AGENT_KIND.GEMINI.id,
  AGENT_KIND.CURSOR.id,
] as const;

export type OpenableHarness = typeof OPENABLE_HARNESSES[number];

/** Harnesses valid for explicit top-level session creation. */
export const CREATABLE_HARNESSES = [
  AGENT_KIND.SHELL.id,
  ...OPENABLE_HARNESSES,
] as const;

export type CreatableHarness = typeof CREATABLE_HARNESSES[number];

const KNOWN_AGENT_KIND_SET: ReadonlySet<string> = new Set(KNOWN_AGENT_KINDS);
const OPENABLE_HARNESS_SET: ReadonlySet<string> = new Set(OPENABLE_HARNESSES);
const CREATABLE_HARNESS_SET: ReadonlySet<string> = new Set(CREATABLE_HARNESSES);

export function isKnownAgentKind(value: string): value is AgentKind {
  return KNOWN_AGENT_KIND_SET.has(value);
}

export function isOpenableHarness(value: string): value is OpenableHarness {
  return OPENABLE_HARNESS_SET.has(value);
}

export function isCreatableHarness(value: string): value is CreatableHarness {
  return CREATABLE_HARNESS_SET.has(value);
}

/** Resolves exact canonical harness ids without rewriting arbitrary commands. */
export function resolveAgentCommand(command: string): string {
  return Object.values(AGENT_KIND).find((definition) => definition.id === command)?.cmd ?? command;
}

export function inferAgentKindFromCommand(command: string | undefined): AgentKind | string {
  const value = (command || AGENT_KIND.SHELL.cmd).trim();
  if (!value || value === AGENT_KIND.SHELL.cmd) return AGENT_KIND.SHELL.id;
  const first = value.split(/\s+/)[0]?.split("/").pop()?.toLowerCase() || value.toLowerCase();
  const definition = Object.values(AGENT_KIND).find((candidate) => candidate.id === first || candidate.cmd === first);
  return definition?.id ?? (first || AGENT_KIND.UNKNOWN.id);
}

export function detectAgentKindFromCommandArgs(command: readonly string[] | undefined): AgentKind | undefined {
  if (!command) return undefined;
  const joined = command.join(" ");
  for (const definition of [
    AGENT_KIND.PI,
    AGENT_KIND.CLAUDE,
    AGENT_KIND.CODEX,
    AGENT_KIND.GEMINI,
    AGENT_KIND.CURSOR,
  ]) {
    if (joined.includes(definition.id)) return definition.id;
  }
  return undefined;
}
