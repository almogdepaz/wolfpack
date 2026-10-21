import { sessionTier, type SessionRuntimeUiInput, type SessionTier } from "../src/agent-runtime-ui";
import { sessionIdentityId, type DelegationSessionLike, type DelegationSessionRow } from "./delegation-sessions";
import { orderDelegationSessionRowsByRank, type SessionOrderIdentity } from "./session-order";

interface TriageSession extends SessionRuntimeUiInput {
  readonly runtimeState?: SessionRuntimeUiInput["runtimeState"] & { readonly changedAt?: unknown };
  readonly activity?: { readonly lastRenderedActivityAt?: unknown };
}

const TIER_PRIORITY = { need: 0, fail: 1, work: 2, idle: 3 } as const;

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Unknown ages follow known ages, then retain the manual/server tie order. */
export function compareSessionTriage(left: TriageSession, right: TriageSession): number {
  const tier = sessionTier(left);
  const priority = TIER_PRIORITY[tier] - TIER_PRIORITY[sessionTier(right)];
  if (priority || tier === "fail") return priority;
  const leftAt = timestamp(tier === "need" ? left.runtimeState?.changedAt : left.activity?.lastRenderedActivityAt);
  const rightAt = timestamp(tier === "need" ? right.runtimeState?.changedAt : right.activity?.lastRenderedActivityAt);
  if (leftAt === null) return rightAt === null ? 0 : 1;
  if (rightAt === null) return -1;
  return tier === "need" ? leftAt - rightAt : rightAt - leftAt;
}

/** A subtree follows its most urgent member, including that member's age/recency. */
export function sessionTriagePriorities<T extends DelegationSessionLike>(
  rows: readonly DelegationSessionRow<T>[],
): ReadonlyMap<DelegationSessionRow<T>, TriageSession> {
  const priorities = new Map<DelegationSessionRow<T>, TriageSession>(rows.map(row => [row, row.session]));
  const byId = new Map<string, DelegationSessionRow<T>>();
  for (const row of rows) {
    const id = sessionIdentityId(row.session);
    if (id) byId.set(id, row);
  }
  for (const row of rows) {
    const visited = new Set<DelegationSessionRow<T>>([row]);
    let ancestor = row.role === "child" ? byId.get(row.parent?.wolfpackSessionId ?? "") : undefined;
    while (ancestor && !visited.has(ancestor)) {
      visited.add(ancestor);
      if (compareSessionTriage(row.session, priorities.get(ancestor)!) < 0) priorities.set(ancestor, row.session);
      ancestor = ancestor.role === "child" ? byId.get(ancestor.parent?.wolfpackSessionId ?? "") : undefined;
    }
  }
  return priorities;
}

/** Tier stays automatic; explicit slots are reserved while other siblings follow recency. */
export function orderTriageSessionRows<T extends DelegationSessionLike>(
  rows: readonly DelegationSessionRow<T>[],
  manualOrder: readonly SessionOrderIdentity[],
  machineUrl: string,
): DelegationSessionRow<T>[] {
  const priorities = sessionTriagePriorities(rows);
  const automatic = [...rows].sort((left, right) => compareSessionTriage(priorities.get(left)!, priorities.get(right)!));
  const siblings = new Map<string, Map<SessionTier, DelegationSessionRow<T>[]>>();
  for (const row of automatic) {
    const parentId = row.role === "child" ? row.parent?.wolfpackSessionId ?? "" : "";
    const tiers = siblings.get(parentId) ?? new Map<SessionTier, DelegationSessionRow<T>[]>();
    const tier = sessionTier(priorities.get(row)!);
    const group = tiers.get(tier) ?? [];
    group.push(row);
    tiers.set(tier, group);
    siblings.set(parentId, tiers);
  }
  const triageOrder: DelegationSessionRow<T>[] = [];
  for (const tiers of siblings.values()) for (const [tier, group] of tiers.entries()) {
    const byId = new Map(group.map(row => [sessionIdentityId(row.session), row]));
    const manual = manualOrder.filter(identity => identity.machineUrl === machineUrl
      && byId.has(identity.sessionId) && (identity.tier === undefined || identity.tier === tier));
    const slots: Array<DelegationSessionRow<T> | undefined> = Array.from({ length: group.length });
    for (const [legacyRank, identity] of manual.entries()) {
      const desired = Math.min(identity.position ?? legacyRank, slots.length - 1);
      let slot = slots.findIndex((row, index) => row === undefined && index >= desired);
      if (slot < 0) slot = slots.findIndex(row => row === undefined);
      slots[slot] = byId.get(identity.sessionId)!;
    }
    const positioned = new Set(manual.map(identity => byId.get(identity.sessionId)!));
    const unpositioned = group.filter(row => !positioned.has(row));
    let next = 0;
    triageOrder.push(...slots.map(row => row ?? unpositioned[next++]!));
  }
  return orderDelegationSessionRowsByRank(automatic, new Map(triageOrder.map((row, index) => [row, index])));
}
