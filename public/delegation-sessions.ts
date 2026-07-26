import { AGENT_STATUS_STATE, isAgentStatusState } from "../src/agent-status-contract";
import type { AgentStatusState } from "../src/agent-status-contract";

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
  readonly unseen?: boolean;
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
  readonly needsInput: number;
  readonly failedStopped: number;
  readonly doneUnseen: number;
  readonly workingOutput: number;
  readonly idle: number;
}

export type DelegationRowRole = "root" | "child" | "orphan";

export interface DelegationSessionRow<TSession extends DelegationSessionLike> {
  readonly session: TSession;
  readonly role: DelegationRowRole;
  readonly parent: DelegationParentReference | null;
  readonly childSummary: DelegationChildSummary | null;
}

const CHILD_ATTENTION_PRIORITY = {
  needsInput: 0,
  failedStopped: 1,
  doneUnseen: 2,
  workingOutput: 3,
  idle: 4,
} as const;

type ChildAttentionBucket = keyof typeof CHILD_ATTENTION_PRIORITY;

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

function runtimeState(session: DelegationSessionLike): AgentStatusState {
  const state = session.runtimeState?.state;
  if (typeof state === "string" && isAgentStatusState(state)) return state;
  return session.triage === "running" ? AGENT_STATUS_STATE.RUNNING : AGENT_STATUS_STATE.IDLE;
}

function childAttentionBucket(session: DelegationSessionLike): ChildAttentionBucket {
  const state = runtimeState(session);
  if (state === AGENT_STATUS_STATE.NEEDS_INPUT) return "needsInput";
  if (state === AGENT_STATUS_STATE.FAILED || state === AGENT_STATUS_STATE.STOPPED) return "failedStopped";
  if (state === AGENT_STATUS_STATE.DONE && session.runtimeState?.unseen === true) return "doneUnseen";
  if (
    state === AGENT_STATUS_STATE.RUNNING ||
    state === AGENT_STATUS_STATE.WORKING ||
    state === AGENT_STATUS_STATE.AUDIT ||
    state === AGENT_STATUS_STATE.CLEANUP ||
    state === AGENT_STATUS_STATE.OUTPUT
  ) {
    return "workingOutput";
  }
  return "idle";
}

function childSort<TSession extends DelegationSessionLike>(a: TSession, b: TSession): number {
  const priority = CHILD_ATTENTION_PRIORITY[childAttentionBucket(a)] - CHILD_ATTENTION_PRIORITY[childAttentionBucket(b)];
  if (priority !== 0) return priority;
  return String(a.name).localeCompare(String(b.name));
}

function emptyChildSummary(): DelegationChildSummary {
  return {
    total: 0,
    needsInput: 0,
    failedStopped: 0,
    doneUnseen: 0,
    workingOutput: 0,
    idle: 0,
  };
}

export function summarizeDelegationChildren(sessions: readonly DelegationSessionLike[]): DelegationChildSummary {
  const summary = { ...emptyChildSummary() };
  for (const session of sessions) {
    summary.total += 1;
    summary[childAttentionBucket(session)] += 1;
  }
  return summary;
}

export function delegationChildSummaryText(summary: DelegationChildSummary): string {
  const parts = [`${summary.total} ${summary.total === 1 ? "child" : "children"}`];
  if (summary.needsInput > 0) parts.push(`${summary.needsInput} needs input`);
  if (summary.failedStopped > 0) parts.push(`${summary.failedStopped} failed/stopped`);
  if (summary.doneUnseen > 0) parts.push(`${summary.doneUnseen} done unseen`);
  if (summary.workingOutput > 0) parts.push(`${summary.workingOutput} working/output`);
  if (summary.idle > 0) parts.push(`${summary.idle} idle`);
  return parts.join(" · ");
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
