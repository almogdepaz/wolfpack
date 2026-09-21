export type PlanStatus = "pending" | "in_progress" | "complete" | "blocked";
/** The installed version-1 wire schema stays byte-for-byte unchanged. */
export interface AgentContextDocument {
  readonly schemaVersion: 1;
  readonly goal: string;
  readonly planItems: readonly { readonly id: string; readonly text: string; readonly status: PlanStatus }[];
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
  readonly nextSteps: readonly string[];
}
export interface ContextBullet { readonly id: string; readonly text: string; readonly details?: string }
export type AgentContextViewModel =
  | { readonly state: "empty"; readonly revision: 0 }
  | { readonly state: "error"; readonly revision: number }
  | { readonly state: "ready"; readonly revision: number; readonly goal: string;
      readonly planItems: readonly (ContextBullet & { readonly status: PlanStatus })[];
      readonly decisions: readonly ContextBullet[]; readonly blockers: readonly ContextBullet[]; readonly nextSteps: readonly ContextBullet[] };

/** Explicit author-provided paragraph boundary, not a generated summary or truncation. */
export function splitBulletText(value: string): { text: string; details?: string } {
  const separator = /\r?\n[\t ]*\r?\n/.exec(value);
  if (!separator) return { text: value };
  const text = value.slice(0, separator.index); const details = value.slice(separator.index + separator[0].length);
  return text.trim() && details.trim() ? { text, details } : { text: value };
}
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function document(value: unknown): value is AgentContextDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.goal === "string" && strings(item.decisions) && strings(item.blockers) && strings(item.nextSteps)
    && Array.isArray(item.planItems) && item.planItems.every((plan) => plan && typeof plan === "object" && typeof plan.id === "string" && typeof plan.text === "string" && ["pending", "in_progress", "complete", "blocked"].includes(plan.status));
}
/** A stale scope/subscription revision must not repaint newer retained UI state. */
export function acceptsRevision(previous: number, next: number): boolean { return Number.isSafeInteger(next) && next >= previous; }
/** Strings stay inert; stable plan IDs / non-plan headlines retain disclosure identity. */
export function contextViewModel(value: unknown, revision = 0): AgentContextViewModel {
  if (value === null) return { state: "empty", revision: 0 };
  if (!document(value)) return { state: "error", revision };
  const bullets = (values: readonly string[]): ContextBullet[] => values.map((value) => { const parts = splitBulletText(value); return { id: parts.text, ...parts }; });
  return {
    state: "ready", revision, goal: value.goal,
    planItems: value.planItems.map((item) => ({ id: item.id, status: item.status, ...splitBulletText(item.text) })),
    decisions: bullets(value.decisions), blockers: bullets(value.blockers), nextSteps: bullets(value.nextSteps),
  };
}
