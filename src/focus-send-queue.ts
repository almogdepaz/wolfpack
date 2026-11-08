import { SESSION_SEND_OUTCOME, sessionSendOk, type SessionSendOutcome } from "./session-send-contract.js";
export type SendOutcome = "sent" | "failed" | "dropped";
/** `user`: an ask typed by the user; `routine`: a server-generated inbox line. */
export type SendOrigin = "user" | "routine";
/** What a write achieved: `submitted` was seen by the harness status, `unverified` was written but not seen within the window. */
export type SendDelivery = "submitted" | "unverified";
/** The session send contract decides: `unverified` cannot be disproven and is not a failure; anything else that is not `submitted` is. */
export function sendDelivery(outcome: SessionSendOutcome): SendDelivery {
  if (!sessionSendOk(false, outcome)) throw new Error(`send ${outcome}`);
  return outcome === SESSION_SEND_OUTCOME.SUBMITTED ? "submitted" : "unverified";
}
interface QueueItem { id: string; text: string; origin: SendOrigin; settled?: (outcome: SendOutcome) => void }
interface Outstanding { id: string; token: string; sawBusy: boolean; unverifiedAt?: number }
/** After an unverified or undelivered send, the next item waits for a new idle token or this long (it may have started a turn). */
export const ROUTINE_FAILURE_FENCE_MS = 2500;
/** Volatile, incarnation-pinned sends. Ambiguous delivery is surfaced, never replayed automatically. */
export class FocusSendQueue {
  private pending: QueueItem[] = [];
  private outstanding?: Outstanding;
  private ticking = false;
  error?: string;
  constructor(private readonly send: (id: string, text: string) => Promise<SendDelivery>, private readonly now: () => number = Date.now) {}
  get size(): number { return this.pending.length; }
  /** Items waiting, or a sent turn not yet observed to finish. */
  get busy(): boolean { return this.pending.length > 0 || this.outstanding !== undefined; }
  enqueue(id: string, text: string, settled?: (outcome: SendOutcome) => void, origin: SendOrigin = "user"): "queued" {
    if (!text.trim() || text.length > 8192 || /[\x00-\x1f\x7f]/.test(text)) throw new Error("ask must be one line, at most 8192 characters");
    if (this.pending.length >= 32) throw new Error("assistant queue is full");
    this.error = undefined;
    this.pending.push({ id, text, origin, settled });
    return "queued";
  }
  clear(reason?: string): void {
    const dropped = this.pending;
    this.pending = []; this.outstanding = undefined; this.error = reason;
    for (const item of dropped) item.settled?.("dropped");
  }
  async tick(sample: { id: string; idle: boolean; token: string }): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if ((this.outstanding && this.outstanding.id !== sample.id) || this.pending.some(p => p.id !== sample.id)) { this.clear("assistant restarted; queued messages were not sent"); return; }
      if (this.outstanding) {
        if (!sample.idle) this.outstanding.sawBusy = true;
        // A changed idle transition can also cover a turn shorter than the observation cadence.
        const fenced = this.outstanding.unverifiedAt !== undefined && this.now() - this.outstanding.unverifiedAt >= ROUTINE_FAILURE_FENCE_MS;
        if (sample.idle && (this.outstanding.sawBusy || sample.token !== this.outstanding.token || fenced)) this.outstanding = undefined;
      }
      if (this.outstanding || !sample.idle) return;
      const item = this.pending.shift();
      if (!item) return;
      const slot: Outstanding = { id: item.id, token: sample.token, sawBusy: false };
      this.outstanding = slot;
      try {
        const delivery = await this.send(item.id, item.text);
        if (delivery === "submitted") { item.settled?.("sent"); return; }
        // Written but not seen submitted within the window (a slow first status change, pi's usual case): the line
        // most likely arrived, so this is not a failure and nothing is reported as one. The routine counts it as a
        // send (it may have been delivered); the next item waits for a new idle token (that turn ran) or the fence.
        item.settled?.("failed");
        if (this.outstanding === slot) slot.unverifiedAt = this.now();
      }
      catch (error) {
        item.settled?.("failed");
        // A routine's undelivered send is reported by the routine (delivery unconfirmed); it must not
        // drop the user's asks queued behind it. The line may still have arrived, so the next item waits
        // for a new idle token (that turn ran) or a short fence (it never arrived), not the same sample.
        // Fence only the slot this send created: a clear() during the send already released it.
        if (item.origin === "routine") { if (this.outstanding === slot) slot.unverifiedAt = this.now(); return; }
        this.clear(`assistant send failed: ${error instanceof Error ? error.message : String(error)}; delivery may be uncertain`);
      }
    } finally { this.ticking = false; }
  }
}
