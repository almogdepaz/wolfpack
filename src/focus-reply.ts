import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { FocusDocument } from "./focus-contract.js";
type FocusReply = NonNullable<FocusDocument["reply"]>;
/** The last ask typed in this view (view memory, not persisted). Browser-clock times only. */
export interface PendingAsk {
  text: string;
  askedAt: number;
  delivery: "sent" | "queued" | "failed";
  /** `reply.updatedAt` on screen when the ask was sent: any other reply is the answer (immune to clock skew). */
  priorReplyAt: string | null;
  /** The assistant incarnation that took the ask; another one means the ask may never have reached it. */
  sessionId?: string;
  /** An error already present in the ask's own answer (a pin note): not this ask's failure. */
  errorAtAsk?: string;
  /** When the ask left the queue: the POST for a sent ask, the first poll that saw the queue drained for a queued one. */
  sentAt?: number;
  /** The assistant was seen working after the ask was sent: its turn ran. */
  sawWorking: boolean;
  /** Set once a poll showed the ask was dropped or failed; it stays (a later routine enqueue clears the queue's error). */
  lost?: { error?: string };
  /** Set once a poll showed the ask's turn over (`terminal`): later restarts, errors or turns are not this ask's. */
  settled?: true;
}
export interface AssistantActivity { state: string; queued: number; error?: string; sessionId?: string }
/** Resting this long after the send without a reply or a turn the view could see: the answer is in its terminal. */
export const ASK_TERMINAL_AFTER_MS = 90_000;
export type FocusReplyView =
  | { kind: "none" }
  | { kind: "reply"; reply: FocusReply }
  | { kind: "answered"; ask: PendingAsk; reply: FocusReply }
  | { kind: "failed"; ask: PendingAsk; error?: string }
  | { kind: "queued" | "waiting" | "terminal" | "unconfirmed"; ask: PendingAsk };
const resting = (state: string) => state === AGENT_STATUS_STATE.DONE || state === AGENT_STATUS_STATE.IDLE;
const busy = (state: string) => state === AGENT_STATUS_STATE.WORKING || state === AGENT_STATUS_STATE.RUNNING;
/** The pending ask from the POST /focus/ask answer (`assistant` is the status that answer carried). */
export function startPendingAsk(text: string, delivery: PendingAsk["delivery"], priorReplyAt: string | null, assistant: AssistantActivity, now: number): PendingAsk {
  return {
    text, askedAt: now, delivery, priorReplyAt, sawWorking: false, sessionId: assistant.sessionId, errorAtAsk: assistant.error,
    ...(delivery === "sent" && { sentAt: now }),
    ...(delivery === "failed" && { lost: { error: assistant.error } }),
  };
}
export function focusReplyView(ask: PendingAsk | undefined, reply: FocusReply | undefined, assistant: AssistantActivity, now: number): FocusReplyView {
  const latest = reply?.text ? reply : undefined;
  if (!ask) return latest ? { kind: "reply", reply: latest } : { kind: "none" };
  if (latest && latest.updatedAt !== ask.priorReplyAt) return { kind: "answered", ask, reply: latest };
  if (ask.lost) return ask.lost.error !== undefined || ask.delivery === "failed" ? { kind: "failed", ask, error: ask.lost.error } : { kind: "unconfirmed", ask };
  if (ask.sentAt === undefined) return { kind: "queued", ask };
  return { kind: ask.settled || turnOver(ask, assistant, now) ? "terminal" : "waiting", ask };
}
/** A sent ask's turn is over: it ran (seen working, now resting with nothing queued), or resting 90 s after the send. */
function turnOver(ask: PendingAsk, assistant: AssistantActivity, now: number): boolean {
  return ask.sentAt !== undefined && resting(assistant.state) && assistant.queued === 0
    && (ask.sawWorking || now - ask.sentAt >= ASK_TERMINAL_AFTER_MS);
}
/** Called on every successful poll while an ask is pending. */
export function observePendingAsk(ask: PendingAsk | undefined, assistant: AssistantActivity, now: number): PendingAsk | undefined {
  if (!ask || ask.lost || ask.settled) return ask;
  // The ask's own enqueue cleared the queue's error, so an error other than the one in its answer is newer than the ask.
  if (assistant.error && assistant.error !== ask.errorAtAsk) return { ...ask, lost: { error: assistant.error } };
  // A status without a session id (starting, unreadable) is no evidence; only a defined, different id is a restart.
  if (assistant.sessionId !== undefined && ask.sessionId !== undefined && assistant.sessionId !== ask.sessionId) return { ...ask, lost: {} };
  // Queued behind another turn: that turn is not the ask's; the ask is sent when the queue drains.
  // A drained queue with the assistant working: that turn is the ask's.
  if (ask.sentAt === undefined) return assistant.queued > 0 ? ask : { ...ask, sentAt: now, sawWorking: busy(assistant.state) };
  if (turnOver(ask, assistant, now)) return { ...ask, settled: true };
  return !ask.sawWorking && busy(assistant.state) ? { ...ask, sawWorking: true } : ask;
}
