import {
  sessionIdentityId,
  type DelegationSessionLike,
  type DelegationSessionRow,
} from "./delegation-sessions";

export const SESSION_ORDER_STORAGE_KEY = "wolfpack-session-order";
const SESSION_ORDER_STORAGE_VERSION = 1;

export interface SessionOrderIdentity {
  readonly machineUrl: string;
  readonly sessionId: string;
}

type SessionOrderStorageReader = Pick<Storage, "getItem">;
type SessionOrderStorageWriter = Pick<Storage, "setItem">;

function isSessionOrderIdentity(value: unknown): value is SessionOrderIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.machineUrl === "string" && typeof candidate.sessionId === "string";
}

function stableIdentity(identity: SessionOrderIdentity): SessionOrderIdentity {
  return { machineUrl: identity.machineUrl, sessionId: identity.sessionId };
}

function identitiesEqual(left: SessionOrderIdentity, right: SessionOrderIdentity): boolean {
  return left.machineUrl === right.machineUrl && left.sessionId === right.sessionId;
}

function includesIdentity(identities: readonly SessionOrderIdentity[], identity: SessionOrderIdentity): boolean {
  return identities.some(candidate => identitiesEqual(candidate, identity));
}

export function loadSessionOrder(storage: SessionOrderStorageReader | null): SessionOrderIdentity[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SESSION_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    if (record.version !== SESSION_ORDER_STORAGE_VERSION || !Array.isArray(record.sessions)) return [];
    const identities: SessionOrderIdentity[] = [];
    for (const value of record.sessions) {
      if (isSessionOrderIdentity(value) && !includesIdentity(identities, value)) identities.push(stableIdentity(value));
    }
    return identities;
  } catch {
    return [];
  }
}

export function saveSessionOrder(
  storage: SessionOrderStorageWriter | null,
  identities: readonly SessionOrderIdentity[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify({
      version: SESSION_ORDER_STORAGE_VERSION,
      sessions: identities.map(stableIdentity),
    }));
    return true;
  } catch {
    return false;
  }
}

export function reconcileSessionOrder(
  stored: readonly SessionOrderIdentity[],
  visible: readonly SessionOrderIdentity[],
): SessionOrderIdentity[] {
  const reconciled = stored.filter(identity => includesIdentity(visible, identity));
  for (const identity of visible) {
    if (!includesIdentity(reconciled, identity)) reconciled.push(identity);
  }
  return reconciled;
}

export function moveSessionRelative(
  order: readonly SessionOrderIdentity[],
  siblingScope: readonly SessionOrderIdentity[],
  moving: SessionOrderIdentity,
  target: SessionOrderIdentity,
  placement: "before" | "after",
): SessionOrderIdentity[] {
  if (identitiesEqual(moving, target)) return [...order];
  if (!includesIdentity(siblingScope, moving) || !includesIdentity(siblingScope, target)) return [...order];
  const withoutMoving = order.filter(identity => !identitiesEqual(identity, moving));
  const targetIndex = withoutMoving.findIndex(identity => identitiesEqual(identity, target));
  if (targetIndex < 0) return [...order];
  const insertionIndex = placement === "before" ? targetIndex : targetIndex + 1;
  withoutMoving.splice(insertionIndex, 0, stableIdentity(moving));
  return withoutMoving;
}

export function resetMachineSessionOrder(
  order: readonly SessionOrderIdentity[],
  machineUrl: string,
): SessionOrderIdentity[] {
  return order.filter(identity => identity.machineUrl !== machineUrl);
}

export function replaceMachineSessionOrder(
  stored: readonly SessionOrderIdentity[],
  machineUrl: string,
  machineOrder: readonly SessionOrderIdentity[],
): SessionOrderIdentity[] {
  return [
    ...resetMachineSessionOrder(stored, machineUrl),
    ...machineOrder.filter(identity => identity.machineUrl === machineUrl),
  ];
}

export function orderDelegationSessionRows<T extends DelegationSessionLike>(
  rows: readonly DelegationSessionRow<T>[],
  order: readonly SessionOrderIdentity[],
  machineUrl: string,
): DelegationSessionRow<T>[] {
  const originalIndex = new Map(rows.map((row, index) => [row, index]));
  const rank = new Map(
    order
      .filter(identity => identity.machineUrl === machineUrl)
      .map((identity, index) => [identity.sessionId, index]),
  );
  const compareRows = (left: DelegationSessionRow<T>, right: DelegationSessionRow<T>): number => {
    const leftRank = rank.get(sessionIdentityId(left.session) ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(sessionIdentityId(right.session) ?? "") ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || (originalIndex.get(left)! - originalIndex.get(right)!);
  };

  const childrenByParent = new Map<string, DelegationSessionRow<T>[]>();
  const roots: DelegationSessionRow<T>[] = [];
  for (const row of rows) {
    const parentId = row.role === "child" ? row.parent?.wolfpackSessionId : undefined;
    if (!parentId) {
      roots.push(row);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(row);
    childrenByParent.set(parentId, children);
  }
  roots.sort(compareRows);
  for (const children of childrenByParent.values()) children.sort(compareRows);

  const ordered: DelegationSessionRow<T>[] = [];
  const visited = new Set<DelegationSessionRow<T>>();
  const appendTree = (row: DelegationSessionRow<T>): void => {
    if (visited.has(row)) return;
    visited.add(row);
    ordered.push(row);
    const sessionId = sessionIdentityId(row.session);
    if (!sessionId) return;
    for (const child of childrenByParent.get(sessionId) ?? []) appendTree(child);
  };
  for (const root of roots) appendTree(root);
  for (const row of rows) appendTree(row);
  return ordered;
}
