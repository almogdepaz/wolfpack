import { AGENT_KIND } from "../agent-kind.js";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_STATE } from "../agent-status-contract.js";
import type { ServerContext } from "./context.js";
import { PinnedSessionService } from "./pinned-session-service.js";
import { FocusSendQueue, sendDelivery } from "../focus-send-queue.js";
import { genericHarness, piHarness } from "../focus-harness.js";
import { programStatusSource } from "./agent-status.js";
import { createLogger, errMsg } from "../log.js";
import { getInstallationId } from "../tailnet-machine-installation.js";
import { getMachineDisplayName } from "../machine-display-name.js";
import { FocusRoutines, localActivitySource, peerActivitySource } from "./focus-routines.js";
const log = createLogger("server");
const VERDICT_TTL_MS = 5_000;
export class FocusRuntime {
  readonly pins: PinnedSessionService;
  readonly queue: FocusSendQueue;
  readonly routines: FocusRoutines;
  private sampledSessionId?: string;
  private lastVerdict?: { at: number; id: string; verdict: { idle: boolean; needsInput: boolean } | undefined };
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly ctx: ServerContext) {
    this.pins = new PinnedSessionService({ backend: ctx.backend, pins: () => ctx.assistantService.pins });
    this.queue = new FocusSendQueue(async (id, text) => {
      const { isAllowedSession } = await import("./http.js");
      if (!(await isAllowedSession("assistant", ctx.backend))) throw new Error("assistant session unavailable");
      const result = await ctx.backend.sendAndObserveSubmission(id, { text, noEnter: false, ensureSubmitted: true, observeMs: 1500 });
      return sendDelivery(result.outcome);
    });
    this.routines = new FocusRoutines({
      folder: ctx.assistantService.folder,
      enabled: () => ctx.assistantService.enabled && this.homeIsLocal(),
      sources: async () => {
        const { discoverActivityPeers } = await import("./activity-peers.js");
        const { peers, failures } = await discoverActivityPeers();
        for (const failure of failures) log.debug("activity peer not reached", failure);
        return [localActivitySource(getInstallationId(), getMachineDisplayName(), ctx.activityJournal), ...peers.map(peerActivitySource)];
      },
      timing: async () => (await import("./project-settings-routes.js")).loadSettings().assistant,
      assistant: async () => { const sample = await this.sample(); this.sampledSessionId = sample?.id; return { sessionId: sample?.id, idle: sample?.idle ?? false }; },
      queueBusy: () => this.queue.busy,
      enqueue: (text, settled) => {
        if (!this.sampledSessionId) throw new Error("assistant is not running");
        this.queue.enqueue(this.sampledSessionId, text, settled, "routine");
        void this.tick().catch(error => log.warn("assistant queue unavailable", { error: errMsg(error) }));
      },
    });
  }
  homeIsLocal(): boolean { const id = getInstallationId(); return (this.ctx.config?.focus?.home ?? id) === id; }
  start(): void {
    if (this.timer) return;
    this.pins.start();
    try { this.ctx.assistantService.refreshSkill(); } catch (error) { log.warn("assistant skill refresh failed", { error: errMsg(error) }); }
    this.routines.start();
    this.timer = setInterval(() => { if (this.queue.busy) void this.tick().catch(error => log.warn("assistant queue unavailable", { error: errMsg(error) })); }, 1000);
    this.timer.unref();
  }
  stop(): void { this.pins.stop(); this.routines.stop(); clearInterval(this.timer); this.timer = undefined; this.queue.clear("server stopped; queue discarded"); }
  async status() {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    const session = (await observeDashboardSessions(this.ctx)).find(s => s.name === "assistant" && s.identity?.projectPath === service.folder);
    const id = session?.identity?.wolfpackSessionId;
    // Focus is a local document; optional live terminal enrichment must not
    // make its reads fail when the broker disconnects (including mid-sample).
    let unavailable = this.ctx.supervisor?.isBrokerReady() === false
      || (session?.runtimeState.authority === AGENT_STATUS_AUTHORITY.BROKER && session.runtimeState.state === AGENT_STATUS_STATE.UNKNOWN);
    let verdict: { idle: boolean; needsInput: boolean } | undefined;
    if (id && service.enabled && !unavailable) {
      try { verdict = await this.verdict(id); }
      catch (error) {
        unavailable = true;
        log.warn("assistant terminal status unavailable", { error: errMsg(error) });
      }
    }
    if (unavailable) this.lastVerdict = undefined;
    // A harness dialog (pi's trust / login / resume selects) has no semantic status and reads as idle from the
    // screen fallback; the harness verdict is what the user needs to see, with the terminal as the action.
    const state = unavailable ? AGENT_STATUS_STATE.UNKNOWN : verdict?.needsInput ? AGENT_STATUS_STATE.NEEDS_INPUT : session?.runtimeState.state ?? (service.enabled ? "starting" : "off");
    return { enabled: service.enabled, folder: service.folder, session: unavailable ? undefined : session?.name, sessionId: unavailable ? undefined : id,
      ...(unavailable && { unavailableReason: "sessions unavailable; reconnecting to the terminal broker" }),
      state, idle: verdict?.idle ?? false, queued: this.queue.size,
      error: service.enabled ? this.queue.error ?? this.pins.errors.assistant : undefined };
  }
  /** Every dashboard polls `/api/focus`; one screen sample serves them for a few seconds, per incarnation (a relaunch resamples). */
  private async verdict(id: string): Promise<{ idle: boolean; needsInput: boolean } | undefined> {
    const now = Date.now();
    if (!this.lastVerdict || this.lastVerdict.id !== id || now - this.lastVerdict.at > VERDICT_TTL_MS) {
      const sample = await this.sample();
      this.lastVerdict = { at: now, id, verdict: sample && { idle: sample.idle, needsInput: sample.needsInput } };
    }
    return this.lastVerdict.verdict;
  }
  async tick(): Promise<void> {
    const sample = await this.sample();
    if (sample) await this.queue.tick(sample);
  }
  /** The assistant's current incarnation, whether its harness is resting, and whether it is waiting on the user. */
  private async sample(): Promise<{ id: string; idle: boolean; needsInput: boolean; token: string } | undefined> {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    const session = (await observeDashboardSessions(this.ctx)).find(s => s.name === "assistant" && s.identity?.projectPath === service.folder);
    if (!session?.identity?.wolfpackSessionId) return undefined;
    const fact = (await this.ctx.backend.listSessionFacts()).find(f => f.alive && f.identity?.wolfpackSessionId === session.identity?.wolfpackSessionId);
    if (!fact) return undefined;
    // A whole turn can finish between polls. The broker's current program timestamp
    // fences both stale idle projections and repeated done states without a sampled working state.
    const state = programStatusSource(fact.programStatus, { observedAt: new Date().toISOString() }) ?? session.runtimeState;
    const adapter = service.pins.find(p => p.name === "assistant")?.harness === AGENT_KIND.PI.id ? piHarness : genericHarness;
    const screen = adapter.needsScreen(state) ? await this.ctx.backend.capturePane(session.name, { scrollbackLines: 0 }) : undefined;
    const quietMs = Date.now() - Date.parse(session.activity.lastRenderedActivityAt ?? session.runtimeState.changedAt);
    const facts = { ...state, screen, quietMs };
    return { id: session.identity.wolfpackSessionId, idle: adapter.isIdle(facts), needsInput: adapter.needsInput(facts), token: fact.programStatus ? `program:${fact.programStatus.updatedAtMs}` : session.runtimeState.changedAt };
  }
}
