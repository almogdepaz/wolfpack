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

/** Keep delegation trees intact; order their roots and each set of siblings. */
export function orderTriageSessionRows<T extends DelegationSessionLike>(
  rows: readonly DelegationSessionRow<T>[],
  manualOrder: readonly SessionOrderIdentity[],
  machineUrl: string,
): DelegationSessionRow<T>[] {
  const manualRows = orderDelegationSessionRows(rows, manualOrder, machineUrl);
  const triageOrder = [...manualRows]
    .sort((left, right) => compareSessionTriage(left.session, right.session))
    .flatMap(row => {
      const sessionId = sessionIdentityId(row.session);
      return sessionId ? [{ machineUrl, sessionId }] : [];
    });
  return orderDelegationSessionRows(manualRows, triageOrder, machineUrl);
}
