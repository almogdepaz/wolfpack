import type { RalphAgent } from "./ralph-agent.js";

/**
 * Extract runner-owned subtask requests from agent output.
 *
 * Codex currently echoes prompt/transcript text, so raw XML-ish tags in its
 * stdout are not trustworthy as a control channel.
 */
export function parseSubtasks(output: string, agent: RalphAgent = "claude"): string[] {
  if (agent === "codex") return [];
  const match = output.match(/<subtasks>([\s\S]*?)<\/subtasks>/);
  if (!match) return [];
  return match[1].split("\n").map(l => l.trim()).filter(l => l.length > 0);
}
