import type { ServerContext } from "./context.js";
import { PinnedSessionService } from "./pinned-session-service.js";
import { FocusSendQueue } from "../focus-send-queue.js";
import { genericHarness, piHarness } from "../focus-harness.js";
import { createLogger, errMsg } from "../log.js";
const log = createLogger("server");
export class FocusRuntime {
  readonly pins: PinnedSessionService;
  readonly queue: FocusSendQueue;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly ctx: ServerContext) {
    this.pins = new PinnedSessionService({ backend: ctx.backend, pins: () => ctx.assistantService.pins });
    this.queue = new FocusSendQueue(async (id, text) => {
      const { isAllowedSession } = await import("./http.js");
      if (!(await isAllowedSession("assistant", ctx.backend))) throw new Error("assistant session unavailable");
      const result = await ctx.backend.sendAndObserveSubmission(id, { text, noEnter: false, ensureSubmitted: true, observeMs: 1500 });
      if (result.outcome !== "submitted") throw new Error(`send ${result.outcome}`);
    });
  }
  start(): void {
    if (this.timer) return;
    this.pins.start();
    this.timer = setInterval(() => { if (this.queue.size) void this.tick().catch(error => log.warn("assistant queue unavailable", { error: errMsg(error) })); }, 1000);
    this.timer.unref();
  }
  stop(): void { this.pins.stop(); clearInterval(this.timer); this.timer = undefined; this.queue.clear("server stopped; queue discarded"); }
  async status() {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    const session = (await observeDashboardSessions(this.ctx)).find(s => s.name === "assistant" && s.identity?.projectPath === service.folder);
    return { enabled: service.enabled, folder: service.folder, session: session?.name, sessionId: session?.identity?.wolfpackSessionId,
      state: session?.runtimeState.state ?? (service.enabled ? "starting" : "off"), queued: this.queue.size,
      error: this.queue.error ?? this.pins.errors.assistant };
  }
  async ask(text: string) {
    if (!this.ctx.assistantService.enabled) throw new Error("assistant is off");
    const status = await this.status();
    if (!status.sessionId) throw new Error("assistant is not running");
    this.queue.enqueue(status.sessionId, text);
    this.start();
    await this.tick();
    return { ...(await this.status()), delivery: this.queue.size ? "queued" : this.queue.error ? "failed" : "sent" };
  }
  async tick(): Promise<void> {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    const session = (await observeDashboardSessions(this.ctx)).find(s => s.name === "assistant" && s.identity?.projectPath === service.folder);
    if (!session?.identity?.wolfpackSessionId) return;
    const state = session.runtimeState;
    const adapter = service.pins.find(p => p.name === "assistant")?.harness === "pi" ? piHarness : genericHarness;
    const screen = state.authority === "fallback" ? await this.ctx.backend.capturePane(session.name, { scrollbackLines: 0 }) : undefined;
    const quietMs = Date.now() - Date.parse(session.activity.lastRenderedActivityAt ?? state.changedAt);
    await this.queue.tick({ id: session.identity.wolfpackSessionId, idle: adapter.isIdle({ ...state, screen, quietMs }), token: state.changedAt });
  }
}
