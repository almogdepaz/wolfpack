import { randomUUID } from "node:crypto";
import type { ChildEventPayload } from "../child-event-contract.ts";

/** Volatile notifications pinned to a parent's stable session incarnation. */
export interface ParentNotification {
  readonly seq: number;
  readonly at: string;
  readonly message: string;
  /** Informational only: the sender name is not authenticated. */
  readonly from?: string;
  /** Present when the server derived this entry from a child (`wolfpack.child_event/v1`). */
  readonly childEvent?: ChildEventPayload;
}

/**
 * Inboxes are memory-only, so their sequences restart with the process. This id
 * names the process that assigned them; a cursor from another boot is stale.
 */
export const PARENT_INBOX_BOOT_ID = randomUUID();

const MAX_PARENT_NOTIFICATIONS = 100;
const inboxes = new Map<string, { nextSeq: number; notifications: ParentNotification[] }>();

/**
 * Append one entry. `describeChildEvent` builds the structured child event from
 * the sequence and timestamp this append assigns, so both name the same entry.
 */
export function appendParentNotification(
  parentSessionId: string,
  notification: Pick<ParentNotification, "message" | "from">,
  describeChildEvent?: (seq: number, at: string) => ChildEventPayload,
): Pick<ParentNotification, "seq" | "at" | "childEvent"> {
  let inbox = inboxes.get(parentSessionId);
  if (!inbox) {
    inbox = { nextSeq: 1, notifications: [] };
    inboxes.set(parentSessionId, inbox);
  }
  const seq = inbox.nextSeq++;
  const at = new Date().toISOString();
  const childEvent = describeChildEvent?.(seq, at);
  const entry: ParentNotification = { ...notification, seq, at, ...(childEvent && { childEvent }) };
  inbox.notifications.push(entry);
  if (inbox.notifications.length > MAX_PARENT_NOTIFICATIONS) inbox.notifications.shift();
  return { seq, at, ...(childEvent && { childEvent }) };
}

export function listParentNotifications(parentSessionId: string, sinceSeq = 0): ParentNotification[] {
  return (inboxes.get(parentSessionId)?.notifications ?? [])
    .filter(entry => entry.seq > sinceSeq)
    .map(entry => ({ ...entry }));
}

export function clearParentInbox(parentSessionId: string): void {
  inboxes.delete(parentSessionId);
}

/** Only a successful authoritative table can establish absent/dead owners. */
export function reconcileParentInboxes(liveSessionIds: ReadonlySet<string>): void {
  for (const id of inboxes.keys()) {
    if (!liveSessionIds.has(id)) clearParentInbox(id);
  }
}
