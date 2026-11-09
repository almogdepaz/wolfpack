import { brokerOutputSequence } from "../broker-output-sequence.js";
import { createLogger, errMsg } from "../log.js";
import type { SessionBackend, SessionListFact } from "./backend-contract.js";

// Geometry can provoke a SIGWINCH redraw without an agent turn. Retain the
// window's final watermark as well as its deadline: the next observer may poll
// long after the redraw ended. This is attribution, not an acknowledgement.
export const VIEWER_REDRAW_MS = 1_000;
const log = createLogger("server");
interface Redraw {
  id: string;
  until: number;
  through?: bigint;
  timer: ReturnType<typeof setTimeout>;
}

export class ViewerRedrawTracker {
  private readonly redraws = new Map<string, Redraw>();
  private readonly inputs = new Map<string, number>();
  private identities = new Map<string, string>();
  constructor(private readonly backend: Pick<SessionBackend, "listSessionFacts">) {}

  begin(name: string): void {
    this.cancel(name);
    // Only already-observed work can have a stop to preserve. Reuse that exact
    // incarnation instead of putting an optional list RPC ahead of geometry.
    const id = this.identities.get(name);
    if (!id || Date.now() - (this.inputs.get(name) ?? -Infinity) < VIEWER_REDRAW_MS) return;
    const redraw: Redraw = { id, until: Date.now() + VIEWER_REDRAW_MS, timer: setTimeout(() => {
      void this.finish(name, redraw);
    }, VIEWER_REDRAW_MS) };
    redraw.timer.unref();
    this.redraws.set(name, redraw);
  }

  private async finish(name: string, redraw: Redraw): Promise<void> {
    if (this.redraws.get(name) !== redraw) return;
    try {
      const fact = (await this.backend.listSessionFacts()).find(f => f.identity?.wolfpackSessionId === redraw.id && f.alive);
      if (this.redraws.get(name) !== redraw) return;
      const sequence = brokerOutputSequence(fact?.outputSequence);
      if (sequence === undefined) this.cancel(name);
      else redraw.through = BigInt(sequence);
    } catch (error) {
      if (this.redraws.get(name) === redraw) this.cancel(name);
      log.debug("viewer redraw watermark unavailable", { name, error: errMsg(error) });
    }
  }

  input(name: string): void {
    this.inputs.set(name, Date.now());
    this.cancel(name);
  }

  private cancel(name: string): void {
    const previous = this.redraws.get(name);
    if (previous) clearTimeout(previous.timer);
    this.redraws.delete(name);
  }

  clear(): void {
    for (const name of this.redraws.keys()) this.cancel(name);
    this.identities.clear();
    this.inputs.clear();
  }

  /** Adopt the completed canonical list; prune ended/replaced incarnations. */
  prune(facts: readonly SessionListFact[]): void {
    const identities = new Map(facts.flatMap(f => f.alive && f.identity ? [[f.name, f.identity.wolfpackSessionId] as const] : []));
    for (const [name, id] of this.identities) {
      if (identities.get(name) !== id) { this.cancel(name); this.inputs.delete(name); }
    }
    for (const [name, at] of this.inputs) if (!identities.has(name) || Date.now() - at >= VIEWER_REDRAW_MS) this.inputs.delete(name);
    this.identities = identities;
  }

  includes(fact: SessionListFact): boolean {
    const redraw = this.redraws.get(fact.name);
    if (!redraw) return false;
    if (fact.identity?.wolfpackSessionId !== redraw.id) { this.cancel(fact.name); return false; }
    if (Date.now() <= redraw.until) return true;
    const sequence = brokerOutputSequence(fact.outputSequence);
    if (redraw.through !== undefined && sequence !== undefined && BigInt(sequence) <= redraw.through) return true;
    // Do not extend a non-work window while a slow/failed watermark RPC waits.
    if (redraw.through !== undefined) this.cancel(fact.name);
    return false;
  }
}
