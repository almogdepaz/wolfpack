export type SendOutcome = "sent" | "failed" | "dropped";
interface QueueItem { id: string; text: string; settled?: (outcome: SendOutcome) => void }
interface Outstanding { id: string; token: string; sawBusy: boolean }
/** Volatile, incarnation-pinned sends. Ambiguous delivery is surfaced, never replayed automatically. */
export class FocusSendQueue {
  private pending: QueueItem[] = [];
  private outstanding?: Outstanding;
  private ticking = false;
  error?: string;
  constructor(private readonly send: (id: string, text: string) => Promise<void>) {}
  get size(): number { return this.pending.length; }
  /** Items waiting, or a sent turn not yet observed to finish. */
  get busy(): boolean { return this.pending.length > 0 || this.outstanding !== undefined; }
  enqueue(id: string, text: string, settled?: (outcome: SendOutcome) => void): "queued" {
    if (!text.trim() || text.length > 8192 || /[\x00-\x1f\x7f]/.test(text)) throw new Error("ask must be one line, at most 8192 characters");
    if (this.pending.length >= 32) throw new Error("assistant queue is full");
    this.error = undefined;
    this.pending.push({ id, text, settled });
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
        if (sample.idle && (this.outstanding.sawBusy || sample.token !== this.outstanding.token)) this.outstanding = undefined;
      }
      if (this.outstanding || !sample.idle) return;
      const item = this.pending.shift();
      if (!item) return;
      this.outstanding = { id: item.id, token: sample.token, sawBusy: false };
      try { await this.send(item.id, item.text); item.settled?.("sent"); }
      catch (error) { item.settled?.("failed"); this.clear(`assistant send failed: ${error instanceof Error ? error.message : String(error)}; delivery may be uncertain`); }
    } finally { this.ticking = false; }
  }
}
