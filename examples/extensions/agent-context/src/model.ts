export type PlanStatus = "pending" | "in_progress" | "complete" | "blocked";
export interface AgentContextDocument {
  readonly schemaVersion: 1;
  readonly goal: string;
  readonly planItems: readonly { readonly id: string; readonly text: string; readonly status: PlanStatus }[];
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
  readonly nextSteps: readonly string[];
}
export type AgentContextViewModel =
  | { readonly state: "empty"; readonly revision: 0 }
  | { readonly state: "error"; readonly revision: number }
  | { readonly state: "ready"; readonly revision: number } & AgentContextDocument;

function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function document(value: unknown): value is AgentContextDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.goal === "string" && strings(item.decisions) && strings(item.blockers) && strings(item.nextSteps)
    && Array.isArray(item.planItems) && item.planItems.every((plan) => plan && typeof plan === "object" && typeof (plan as Record<string, unknown>).id === "string" && typeof (plan as Record<string, unknown>).text === "string" && ["pending", "in_progress", "complete", "blocked"].includes((plan as Record<string, unknown>).status as string));
}
/** Keeps untrusted document strings as values; UI rendering always assigns textContent. */
export function contextViewModel(value: unknown, revision = 0): AgentContextViewModel {
  if (value === null) return { state: "empty", revision: 0 };
  if (!document(value)) return { state: "error", revision };
  return { state: "ready", revision, ...value };
}
