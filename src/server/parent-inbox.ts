/** Volatile notifications pinned to a parent's stable session incarnation. */
export interface ParentNotification {
  readonly seq: number;
  readonly at: string;
  readonly message: string;
  /** Informational only: the sender name is not authenticated. */
  readonly from?: string;
}

const MAX_PARENT_NOTIFICATIONS = 100;
const inboxes = new Map<string, { nextSeq: number; notifications: ParentNotification[] }>();

export function appendParentNotification(
  parentSessionId: string,
  notification: Pick<ParentNotification, "message" | "from">,
): Pick<ParentNotification, "seq" | "at"> {
  let inbox = inboxes.get(parentSessionId);
  if (!inbox) {
    inbox = { nextSeq: 1, notifications: [] };
    inboxes.set(parentSessionId, inbox);
  }
  const entry: ParentNotification = { ...notification, seq: inbox.nextSeq++, at: new Date().toISOString() };
  inbox.notifications.push(entry);
  if (inbox.notifications.length > MAX_PARENT_NOTIFICATIONS) inbox.notifications.shift();
  return { seq: entry.seq, at: entry.at };
}

export function listParentNotifications(parentSessionId: string, sinceSeq = 0): ParentNotification[] {
  return (inboxes.get(parentSessionId)?.notifications ?? [])
    .filter(entry => entry.seq > sinceSeq)
    .map(entry => ({ ...entry }));
}

export function clearParentInbox(parentSessionId: string): void {
  inboxes.delete(parentSessionId);
}
