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
  private readonly pending = new Map<string, object>();
  private readonly inputs = new Map<string, number>();
  constructor(private readonly backend: Pick<SessionBackend, "listSessionFacts">) {}

  async begin(name: string): Promise<void> {
    // Bind geometry attribution to the incarnation before applying the resize.
    this.cancel(name);
    if (Date.now() - (this.inputs.get(name) ?? -Infinity) < VIEWER_REDRAW_MS) return;
    const token = {};
    this.pending.set(name, token);
    let facts: SessionListFact[];
    try { facts = await this.backend.listSessionFacts(); }
    catch (error) {
      if (this.pending.get(name) === token) this.pending.delete(name);
      log.debug("viewer redraw attribution unavailable", { name, error: errMsg(error) });
      return;
    }
    if (this.pending.get(name) !== token) return;
    this.pending.delete(name);
    const id = facts.find(f => f.name === name && f.alive)?.identity?.wolfpackSessionId;
    if (!id) return;
    const redraw: Redraw = { id, until: Date.now() + VIEWER_REDRAW_MS, timer: setTimeout(() => {
      void this.finish(name, redraw);
    }, VIEWER_REDRAW_MS) };
    redraw.timer.unref();
    this.redraws.set(name, redraw);
  }

  private async finish(name: string, redraw: Redraw): Promise<void> {
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
    this.pending.delete(name);
    const previous = this.redraws.get(name);
    if (previous) clearTimeout(previous.timer);
    this.redraws.delete(name);
  }

  clear(): void {
    for (const name of this.redraws.keys()) this.cancel(name);
    this.pending.clear();
    this.inputs.clear();
  }

  prune(facts: readonly SessionListFact[]): void {
    const names = new Set(facts.filter(f => f.alive).map(f => f.name));
    for (const name of this.redraws.keys()) if (!names.has(name)) this.cancel(name);
    for (const [name, at] of this.inputs) if (!names.has(name) || Date.now() - at >= VIEWER_REDRAW_MS) this.inputs.delete(name);
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
