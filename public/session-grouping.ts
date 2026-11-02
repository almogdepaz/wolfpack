import { isSessionOrganization } from "../src/session-organization-contract";
import { delegationRootSession, sessionIdentityId } from "./delegation-sessions";
import type { DelegationSessionLike, DelegationSessionRow } from "./delegation-sessions";

/** Resolve from the full machine inventory, never the filtered/expanded rows. */
export function sessionGroupRoot<T extends DelegationSessionLike>(inventory: readonly T[], target: T): T | null {
  const ids = inventory.map(sessionIdentityId).filter(id => id !== null);
  // Ambiguous inventory is not mutation authority.
  return new Set(ids).size === ids.length ? delegationRootSession(inventory, target, true) : null;
}

export interface SessionLabelGroup<T extends DelegationSessionLike> {
  readonly kind: "group" | "unavailable" | "unsupported";
  readonly label: string | null;
  readonly rows: DelegationSessionRow<T>[];
}

/** Partition ordered rows without changing urgency/manual sibling order within a bucket. */
export function projectSessionGroups<T extends DelegationSessionLike>(inventory: readonly T[], rows: readonly DelegationSessionRow<T>[]): SessionLabelGroup<T>[] {
  const groups = new Map<string, SessionLabelGroup<T>>();
  for (const row of rows) {
    const root = sessionGroupRoot(inventory, row.session);
    const organization = root?.organization;
    const kind = root && organization === undefined ? "unsupported" : isSessionOrganization(organization) ? "group" : "unavailable";
    const label = isSessionOrganization(organization) ? organization.group : null;
    const key = JSON.stringify([kind, label]);
    let group = groups.get(key);
    if (!group) { group = { kind, label, rows: [] }; groups.set(key, group); }
    group.rows.push(row);
  }
  const rank = (group: SessionLabelGroup<T>) => group.kind === "group" ? group.label === null ? 1 : 0 : group.kind === "unavailable" ? 2 : 3;
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.label! < b.label! ? -1 : a.label! > b.label! ? 1 : 0));
}

/** Presentation only: canonical labels never collide with built-in buckets or actions. */
export function sessionGroupLabel(group: string | null): string {
  return group === null ? "No group" : `Group “${group}”`;
}

const COLLAPSE_KEY = "wolfpack-session-group-collapse";
export function sessionGroupKey(machine: string, kind: string, label: string | null): string {
  return JSON.stringify([machine, kind, label]);
}
export function loadSessionGroupCollapse(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(COLLAPSE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.length <= 1024) : []);
  } catch { return new Set(); }
}
export function saveSessionGroupCollapse(storage: Pick<Storage, "setItem"> | null, collapsed: ReadonlySet<string>): boolean {
  try { if (!storage) return false; storage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); return true; }
  catch { return false; }
}
