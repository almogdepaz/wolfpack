export type PlanStatus = "pending" | "in_progress" | "complete" | "blocked";
export interface ContextBullet {
  readonly id: string;
  /** Short, agent-authored headline. Legacy text is preserved, never summarized by the UI. */
  readonly text: string;
  readonly details?: string;
}
export interface AgentContextDocument {
  readonly schemaVersion: 1;
  readonly goal: string;
  readonly planItems: readonly (ContextBullet & { readonly status: PlanStatus })[];
  readonly decisions: readonly (string | ContextBullet)[];
  readonly blockers: readonly (string | ContextBullet)[];
  readonly nextSteps: readonly (string | ContextBullet)[];
}
export type AgentContextViewModel =
  | { readonly state: "empty"; readonly revision: 0 }
  | { readonly state: "error"; readonly revision: number }
  | ({ readonly state: "ready"; readonly revision: number } & AgentContextDocument);

function bullet(value: unknown): value is ContextBullet {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.text === "string"
    && (item.details === undefined || typeof item.details === "string");
}
function bullets(value: unknown): value is readonly (string | ContextBullet)[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" || (bullet(item) && typeof item.details === "string"));
}
function document(value: unknown): value is AgentContextDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.goal === "string" && bullets(item.decisions) && bullets(item.blockers) && bullets(item.nextSteps)
    && Array.isArray(item.planItems) && item.planItems.every((plan) => bullet(plan) && "status" in plan && typeof plan.status === "string" && ["pending", "in_progress", "complete", "blocked"].includes(plan.status));
}
/** A stale scope/subscription revision must not repaint newer retained UI state. */
export function acceptsRevision(previous: number, next: number): boolean { return Number.isSafeInteger(next) && next >= previous; }
/** Keeps untrusted document strings as values; UI rendering always assigns textContent. */
export function contextViewModel(value: unknown, revision = 0): AgentContextViewModel {
  if (value === null) return { state: "empty", revision: 0 };
  if (!document(value)) return { state: "error", revision };
  return { ...value, state: "ready", revision };
}
