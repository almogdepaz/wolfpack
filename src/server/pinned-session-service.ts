import { reconcilePinned, recordPinFailure, PIN_STABLE_MS, type PinHistory, type PinnedSession } from "../pinned-sessions.js";
import type { SessionBackend } from "./backend-contract.js";
import { createLogger, errMsg } from "../log.js";
const log = createLogger("server");
export class PinnedSessionService {
  readonly history: Record<string, PinHistory> = {};
  readonly errors: Record<string, string> = {};
  private liveSince = new Map<string, number>();
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: { backend: SessionBackend; pins: () => readonly PinnedSession[]; now?: () => number }) {}
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
  tick(): Promise<void> { return this.flight ??= this.reconcile().catch(error => { log.warn("pinned reconciliation unavailable", { error: errMsg(error) }); }).finally(() => { this.flight = undefined; }); }
  private async reconcile(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const pins = this.options.pins();
    // A failed list is unavailable, not an empty broker. Do not spawn in that case.
    const facts = await this.options.backend.listSessionFacts();
    const live = facts.filter(f => f.alive).map(f => f.name);
    for (const name of Object.keys(this.history)) if (!pins.some(p => p.name === name)) { delete this.history[name]; delete this.errors[name]; }
    for (const pin of pins) {
      if (live.includes(pin.name)) {
        const since = this.liveSince.get(pin.name) ?? now;
        this.liveSince.set(pin.name, since);
        if (now - since >= PIN_STABLE_MS) { delete this.history[pin.name]; delete this.errors[pin.name]; }
      } else if (this.liveSince.has(pin.name)) {
        this.liveSince.delete(pin.name);
        this.history[pin.name] = recordPinFailure(this.history[pin.name], now);
      }
    }
    for (const action of reconcilePinned(pins, live, this.history, now)) {
      if (action.action === "failed") { this.errors[action.name] = "pinned session failed repeatedly; disable and enable to retry"; continue; }
      if (action.action !== "create") continue;
      const pin = pins.find(p => p.name === action.name)!;
      try {
        if (facts.some(f => f.alive && f.identity?.projectPath === pin.cwd)) throw new Error("a live session already owns the pinned working directory");
        await this.options.backend.createSession(pin.name, pin.cwd, pin.command[0], () => ({ agentCmd: pin.command[0]! }), { agentKind: pin.harness, pinnedCommand: pin.command });
        this.liveSince.set(pin.name, now);
        delete this.errors[pin.name];
      } catch (error) {
        this.history[pin.name] = recordPinFailure(this.history[pin.name], now);
        this.errors[pin.name] = errMsg(error);
        log.warn("pinned session create failed", { name: pin.name, error: errMsg(error) });
      }
    }
  }
}
