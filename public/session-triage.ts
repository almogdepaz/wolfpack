import { sessionTier, type SessionRuntimeUiInput } from "../src/agent-runtime-ui";
import { sessionIdentityId, type DelegationSessionLike, type DelegationSessionRow } from "./delegation-sessions";
import { orderDelegationSessionRows, type SessionOrderIdentity } from "./session-order";

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

/** Tier stays automatic; explicit manual positions precede unpositioned siblings. */
export function orderTriageSessionRows<T extends DelegationSessionLike>(
  rows: readonly DelegationSessionRow<T>[],
  manualOrder: readonly SessionOrderIdentity[],
  machineUrl: string,
): DelegationSessionRow<T>[] {
  const manualRows = orderDelegationSessionRows(rows, manualOrder, machineUrl);
  const priorities = sessionTriagePriorities(rows);
  const ranks = new Map(manualOrder.filter(identity => identity.machineUrl === machineUrl).map((identity, index) => [identity.sessionId, index]));
  const triageOrder = [...manualRows]
    .sort((left, right) => {
      const leftPriority = priorities.get(left)!;
      const rightPriority = priorities.get(right)!;
      const tier = TIER_PRIORITY[sessionTier(leftPriority)] - TIER_PRIORITY[sessionTier(rightPriority)];
      if (tier) return tier;
      const leftRank = ranks.get(sessionIdentityId(left.session) ?? "");
      const rightRank = ranks.get(sessionIdentityId(right.session) ?? "");
      if (leftRank !== undefined || rightRank !== undefined) {
        return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
      }
      return compareSessionTriage(leftPriority, rightPriority);
    })
    .flatMap(row => {
      const sessionId = sessionIdentityId(row.session);
      return sessionId ? [{ machineUrl, sessionId }] : [];
    });
  return orderDelegationSessionRows(manualRows, triageOrder, machineUrl);
}
