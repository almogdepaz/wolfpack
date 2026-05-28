export type RalphIterationControl =
  | { readonly kind: "done" }
  | { readonly kind: "subtasks"; readonly subtasks: readonly string[] }
  | { readonly kind: "incomplete"; readonly reason: string };

export function parseSubtasks(output: string): string[] {
  const match = output.match(/<subtasks>([\s\S]*?)<\/subtasks>/);
  if (!match) return [];
  return match[1].split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

export function hasDoneSignal(output: string): boolean {
  const match = output.match(/<done>([\s\S]*?)<\/done>/);
  return Boolean(match?.[1]?.trim());
}

export function classifyRalphIterationOutput(output: string): RalphIterationControl {
  const subtasks = parseSubtasks(output);
  if (subtasks.length > 0) return { kind: "subtasks", subtasks };
  if (hasDoneSignal(output)) return { kind: "done" };
  return { kind: "incomplete", reason: "missing non-empty <done> or <subtasks> control block" };
}
