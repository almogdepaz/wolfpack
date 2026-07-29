export interface DelegationParentReference {
  readonly wolfpackSessionId: string;
  readonly wolfpackSessionName: string;
}

export interface DelegationSessionIdentity {
  readonly wolfpackSessionId?: string;
  readonly wolfpackSessionName?: string;
  readonly parentSession?: unknown;
}

export interface DelegationRuntimeState {
  readonly state?: string;
  readonly authority?: string;
  readonly freshness?: string;
  readonly source?: string;
  readonly stale?: boolean;
}

export interface DelegationSessionLike {
  readonly name: string;
  readonly lastLine?: string;
  readonly identity?: DelegationSessionIdentity;
  readonly runtimeState?: DelegationRuntimeState;
  readonly triage?: string;
}

export interface DelegationChildSummary {
  readonly total: number;
}

export type DelegationRowRole = "root" | "child" | "orphan";

export interface DelegationSessionRow<TSession extends DelegationSessionLike> {
  readonly session: TSession;
  readonly role: DelegationRowRole;
  readonly parent: DelegationParentReference | null;
  readonly childSummary: DelegationChildSummary | null;
}

export function sessionIdentityId(session: DelegationSessionLike): string | null {
  const id = session.identity?.wolfpackSessionId;
  return typeof id === "string" && id ? id : null;
}

export function sessionParentReference(session: DelegationSessionLike): DelegationParentReference | null {
  const parent = session.identity?.parentSession;
  if (!parent || typeof parent !== "object") return null;
  if (!("wolfpackSessionId" in parent) || !("wolfpackSessionName" in parent)) return null;
  const id = parent.wolfpackSessionId;
  const name = parent.wolfpackSessionName;
  if (typeof id !== "string" || !id) return null;
  if (typeof name !== "string" || !name) return null;
  return { wolfpackSessionId: id, wolfpackSessionName: name };
}

function childSort<TSession extends DelegationSessionLike>(a: TSession, b: TSession): number {
  return String(a.name).localeCompare(String(b.name));
}

export function summarizeDelegationChildren(sessions: readonly DelegationSessionLike[]): DelegationChildSummary {
  return { total: sessions.length };
}

export function delegationChildSummaryText(summary: DelegationChildSummary): string {
  return `${summary.total} ${summary.total === 1 ? "child" : "children"}`;
}

export function delegationRootSession<TSession extends DelegationSessionLike>(
  sessions: readonly TSession[],
  target: TSession,
): TSession | null {
  const targetId = sessionIdentityId(target);
  const sessionsById = new Map(
    sessions
      .map(session => [sessionIdentityId(session), session] as const)
      .filter((entry): entry is readonly [string, TSession] => entry[0] !== null),
  );
  let current = targetId ? sessionsById.get(targetId) : sessions.find(session => session === target);
  const visited = new Set<string>();

  while (current) {
    const currentId = sessionIdentityId(current);
    if (currentId) {
      if (visited.has(currentId)) return null;
      visited.add(currentId);
    }
    const parent = sessionParentReference(current);
    if (!parent) return current;
    current = sessionsById.get(parent.wolfpackSessionId);
  }
  return null;
}

export function projectDelegationSessions<TSession extends DelegationSessionLike>(
  sessions: readonly TSession[],
): DelegationSessionRow<TSession>[] {
  const sessionIds = new Set(sessions.map(sessionIdentityId).filter((id): id is string => Boolean(id)));
  const children = new Map<string, TSession[]>();
  const topLevel: TSession[] = [];
  const orphaned: TSession[] = [];

  for (const session of sessions) {
    const parent = sessionParentReference(session);
    if (!parent) {
      topLevel.push(session);
      continue;
    }
    if (!sessionIds.has(parent.wolfpackSessionId)) {
      orphaned.push(session);
      continue;
    }
    const siblings = children.get(parent.wolfpackSessionId) || [];
    siblings.push(session);
    children.set(parent.wolfpackSessionId, siblings);
  }

  for (const siblings of children.values()) {
    siblings.sort(childSort);
  }

  const ordered: DelegationSessionRow<TSession>[] = [];
  const visited = new Set<string | TSession>();
  const appendTree = (session: TSession, roleOverride?: DelegationRowRole): void => {
    const id = sessionIdentityId(session);
    const visitKey = id || session;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const parent = sessionParentReference(session);
    const childSessions = id ? children.get(id) || [] : [];
    ordered.push({
      session,
      role: roleOverride ?? (parent ? "child" : "root"),
      parent,
      childSummary: childSessions.length > 0 ? summarizeDelegationChildren(childSessions) : null,
    });
    for (const child of childSessions) appendTree(child);
  };

  for (const session of topLevel) appendTree(session);
  for (const session of orphaned) appendTree(session, "orphan");
  for (const session of sessions) appendTree(session);
  return ordered;
}

export function delegationGridMembers<TSession extends DelegationSessionLike>(
  sessions: readonly TSession[],
  root: TSession,
): DelegationSessionRow<TSession>[] {
  const rootId = sessionIdentityId(root);
  const rows = projectDelegationSessions(sessions);
  const rootRow = rows.find(row => row.session === root || (rootId !== null && sessionIdentityId(row.session) === rootId));
  if (!rootRow || rootRow.role !== "root") return [];

  const memberIds = new Set<string>();
  if (rootId) memberIds.add(rootId);
  return rows.filter(row => {
    if (row === rootRow) return true;
    if (!row.parent || !memberIds.has(row.parent.wolfpackSessionId)) return false;
    const id = sessionIdentityId(row.session);
    if (id) memberIds.add(id);
    return true;
  });
}
