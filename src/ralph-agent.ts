export const RALPH_AGENTS = ["claude", "codex", "gemini", "cursor"] as const;

export type RalphAgent = (typeof RALPH_AGENTS)[number];

export function isRalphAgent(agent: string): agent is RalphAgent {
  return (RALPH_AGENTS as readonly string[]).includes(agent);
}
