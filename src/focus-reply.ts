import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { FocusDocument } from "./focus-contract.js";
type FocusReply = NonNullable<FocusDocument["reply"]>;
/** The last ask typed in this view (view memory, not persisted). */
export interface PendingAsk {
  text: string;
  /** Browser clock; used only for the terminal fallback, never compared with the home server's reply time. */
  askedAt: number;
  delivery: "sent" | "queued" | "failed";
  /** `reply.updatedAt` on screen when the ask was sent: any other reply is the answer (immune to clock skew). */
  priorReplyAt: string | null;
  /** The assistant was seen working after the ask: its turn ran. */
  sawWorking: boolean;
}
export interface AssistantActivity { state: string; queued: number }
/** Without a reply and without a turn the view could see, the answer is in its terminal after this long. */
export const ASK_TERMINAL_AFTER_MS = 90_000;
export type FocusReplyView =
  | { kind: "none" }
  | { kind: "reply"; reply: FocusReply }
  | { kind: "answered"; ask: PendingAsk; reply: FocusReply }
  | { kind: "queued" | "waiting" | "terminal" | "failed"; ask: PendingAsk };
const resting = (state: string) => state === AGENT_STATUS_STATE.DONE || state === AGENT_STATUS_STATE.IDLE;
export function focusReplyView(ask: PendingAsk | undefined, reply: FocusReply | undefined, assistant: AssistantActivity, now: number): FocusReplyView {
  const latest = reply?.text ? reply : undefined;
  if (!ask) return latest ? { kind: "reply", reply: latest } : { kind: "none" };
  if (latest && latest.updatedAt !== ask.priorReplyAt) return { kind: "answered", ask, reply: latest };
  if (ask.delivery === "failed") return { kind: "failed", ask };
  if (ask.delivery === "queued" && assistant.queued > 0) return { kind: "queued", ask };
  const turnRan = ask.sawWorking && resting(assistant.state) && assistant.queued === 0;
  return { kind: turnRan || now - ask.askedAt >= ASK_TERMINAL_AFTER_MS ? "terminal" : "waiting", ask };
}
/** Called on every successful poll while an ask is pending. */
export function observePendingAsk(ask: PendingAsk | undefined, assistant: AssistantActivity): PendingAsk | undefined {
  const busy = assistant.state === AGENT_STATUS_STATE.WORKING || assistant.state === AGENT_STATUS_STATE.RUNNING;
  return ask && !ask.sawWorking && busy ? { ...ask, sawWorking: true } : ask;
}
