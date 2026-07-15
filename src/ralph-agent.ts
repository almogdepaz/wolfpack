export const RALPH_AGENTS = ["claude", "codex", "gemini", "cursor"] as const;

export type RalphAgent = (typeof RALPH_AGENTS)[number];

export function isRalphAgent(agent: string): agent is RalphAgent {
  return (RALPH_AGENTS as readonly string[]).includes(agent);
}

export function configuredRalphAgents(commands: readonly string[]): RalphAgent[] {
  const agents: RalphAgent[] = [];
  const seen = new Set<RalphAgent>();
  for (const command of commands) {
    if (!isRalphAgent(command) || seen.has(command)) continue;
    seen.add(command);
    agents.push(command);
  }
  return agents;
}

export function selectConfiguredRalphAgent(
  requested: string | undefined,
  configured: readonly RalphAgent[],
): RalphAgent | null {
  if (requested !== undefined) {
    return isRalphAgent(requested) && configured.includes(requested) ? requested : null;
  }
  return configured[0] ?? null;
}
