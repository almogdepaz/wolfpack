export const AGENT_KIND = {
  SHELL: "shell",
  PI: "pi",
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini",
  CURSOR: "cursor",
  UNKNOWN: "unknown",
} as const;

export const KNOWN_AGENT_KINDS = [
  AGENT_KIND.SHELL,
  AGENT_KIND.CLAUDE,
  AGENT_KIND.CODEX,
  AGENT_KIND.PI,
  AGENT_KIND.GEMINI,
  AGENT_KIND.CURSOR,
  AGENT_KIND.UNKNOWN,
] as const;

export type AgentKind = typeof KNOWN_AGENT_KINDS[number];

export const OPENABLE_HARNESSES = [
  AGENT_KIND.PI,
  AGENT_KIND.CLAUDE,
  AGENT_KIND.CODEX,
  AGENT_KIND.GEMINI,
  AGENT_KIND.CURSOR,
] as const;

export type OpenableHarness = typeof OPENABLE_HARNESSES[number];

/** Harnesses valid for explicit top-level session creation. */
export const CREATABLE_HARNESSES = [
  AGENT_KIND.SHELL,
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

export function inferAgentKindFromCommand(command: string | undefined): AgentKind | string {
  const value = (command || AGENT_KIND.SHELL).trim();
  if (!value || value === AGENT_KIND.SHELL) return AGENT_KIND.SHELL;
  const first = value.split(/\s+/)[0]?.split("/").pop()?.toLowerCase() || value.toLowerCase();
  if (isKnownAgentKind(first)) return first;
  return first || AGENT_KIND.UNKNOWN;
}

export function detectAgentKindFromCommandArgs(command: readonly string[] | undefined): AgentKind | undefined {
  if (!command) return undefined;
  const joined = command.join(" ");
  for (const agent of OPENABLE_HARNESSES) {
    if (joined.includes(agent)) return agent;
  }
  return undefined;
}
