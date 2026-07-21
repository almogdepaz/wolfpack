export {
  RALPH_AGENTS,
  isRalphAgent,
} from "./agent-kind.js";
export type { RalphAgent } from "./agent-kind.js";

import {
  RALPH_AGENTS,
  isRalphAgent,
} from "./agent-kind.js";
import type { RalphAgent } from "./agent-kind.js";

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
