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
  private settingsChange: Promise<unknown> = Promise.resolve();
  /** Home moves and async assistant enable/disable must never race. */
  configure<T>(change: () => T | Promise<T>): Promise<T> {
    const next = this.settingsChange.then(change, change);
    this.settingsChange = next.catch(() => undefined);
    return next;
  }
  private sampledSessionId?: string;
  private lastVerdict?: { at: number; id: string; verdict: { idle: boolean; needsInput: boolean } | undefined };
  private timer?: ReturnType<typeof setInterval>;
  private tickFlight?: Promise<void>;
  private lifetime = 0;
  private tickError?: string;
  constructor(private readonly ctx: ServerContext) {
    this.pins = new PinnedSessionService({ backend: ctx.backend, pins: () => (ctx.assistantService.config?.pinnedSessions ?? []).filter(pin => this.homeIsLocal() || pin.name !== "assistant" || pin.cwd !== ctx.assistantService.folder), prepareLaunch: pin => ctx.assistantService.prepareLaunch(pin) });
    this.queue = new FocusSendQueue(async (id, text, origin) => {
      const prompt = origin === "routine" ? ctx.assistantService.routinePrompt(text) : { text };
      const { isAllowedSession } = await import("./http.js");
      if (!(await isAllowedSession("assistant", ctx.backend))) throw new Error("assistant session unavailable");
      const result = await ctx.backend.sendAndObserveSubmission(id, { text: prompt.text, noEnter: false, ensureSubmitted: true, observeMs: 1500 });
      const delivery = sendDelivery(result.outcome);
      ctx.assistantService.routineSent(prompt.generation);
      return delivery;
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
        this.requestTick();
      },
    });
  }
  homeIsLocal(): boolean { const id = getInstallationId(); return (this.ctx.config?.focus?.home ?? id) === id; }
  start(): void {
    if (this.timer) return;
    this.lifetime++;
    try { this.ctx.assistantService.refreshSkill(); } catch (error) { log.warn("assistant skill refresh failed", { error: errMsg(error) }); }
    this.pins.start();
    this.routines.start();
    this.timer = setInterval(() => { this.requestTick(); }, 1000);
    this.timer.unref();
  }
  stop(): void { this.lifetime++; this.pins.stop(); this.routines.stop(); clearInterval(this.timer); this.timer = undefined; this.queue.clear("server stopped; queue discarded"); }
  async status() {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    const enabled = service.enabled && this.homeIsLocal();
    const session = (await observeDashboardSessions(this.ctx)).find(s => s.name === "assistant" && s.identity?.projectPath === service.folder);
    const id = session?.identity?.wolfpackSessionId;
    // Focus is a local document; optional live terminal enrichment must not
    // make its reads fail when the broker disconnects (including mid-sample).
    let unavailable = this.ctx.supervisor?.isBrokerReady() === false
      || (session?.runtimeState.authority === AGENT_STATUS_AUTHORITY.BROKER && session.runtimeState.state === AGENT_STATUS_STATE.UNKNOWN);
    let verdict: { idle: boolean; needsInput: boolean } | undefined;
    if (id && enabled && !unavailable) {
      try { verdict = await this.verdict(id); }
      catch (error) {
        unavailable = true;
        log.warn("assistant terminal status unavailable", { error: errMsg(error) });
      }
    }
    if (unavailable) this.lastVerdict = undefined;
    // A harness dialog (pi's trust / login / resume selects) has no semantic status and reads as idle from the
    // screen fallback; the harness verdict is what the user needs to see, with the terminal as the action.
    const state = unavailable ? AGENT_STATUS_STATE.UNKNOWN : verdict?.needsInput ? AGENT_STATUS_STATE.NEEDS_INPUT : session?.runtimeState.state ?? (enabled ? "starting" : "off");
    return { enabled, folder: service.folder, session: unavailable ? undefined : session?.name, sessionId: unavailable ? undefined : id,
      ...(unavailable && { unavailableReason: "sessions unavailable; reconnecting to the terminal broker" }),
      state, idle: verdict?.idle ?? false, queued: this.queue.size,
      error: enabled ? this.queue.error ?? this.pins.errors.assistant : undefined };
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
  private requestTick(): void {
    void this.tick().then(() => { this.tickError = undefined; }, error => {
      const message = errMsg(error);
      if (this.tickError !== message) log.warn("assistant runtime unavailable", { error: message });
      this.tickError = message;
    });
  }
  tick(): Promise<void> {
    const lifetime = this.lifetime;
    const active = () => !!this.timer && lifetime === this.lifetime;
    return this.tickFlight ??= this.configure(async () => {
      if (lifetime !== this.lifetime) return;
      const sample = this.queue.busy ? await this.sample() : undefined;
      if (lifetime !== this.lifetime) return;
      if (sample) await this.queue.tick(sample);
      const service = this.ctx.assistantService;
      if (!active() || !service.pins.some(pin => service.isManagedPin(pin)) || !this.homeIsLocal() || this.queue.busy || !service.conversationChanged()) return;
      // Share the routine lock, not its cached status: a pull might still be about to publish an inbox.
      await this.routines.withNoInbox(async () => {
        const { activePtySessions } = await import("./websocket.js");
        const userActive = () => {
          const attached = activePtySessions.get("assistant");
          return !!(attached?.viewer || attached?.pendingViewer) || this.ctx.activityRecorder.hasRecentInput("assistant");
        };
        if (userActive()) return;
        const current = await this.sample();
        if (!active() || !current?.idle || current.needsInput || this.queue.busy || !service.enabled || !this.homeIsLocal()) return;
        // Recheck incarnation and program token after asynchronous sampling; never kill by reusable name.
        const facts = await this.ctx.backend.listSessionFacts();
        const fact = facts.find(f => f.alive && f.identity?.wolfpackSessionId === current.id);
        const state = programStatusSource(fact?.programStatus, { observedAt: new Date().toISOString() });
        if (!active() || !fact || fact.programStatus?.updatedAtMs !== current.programAt
          || (fact.programStatus && (!state || !piHarness.isIdle(state)))
          || (current.programAt === undefined && (!current.fallback || current.fallback.outputSequence === undefined
            || fact.outputSequence !== current.fallback.outputSequence || !genericHarness.isIdle(current.fallback)))
          || this.queue.busy || userActive() || !service.enabled || !this.homeIsLocal()) return;
        await this.ctx.backend.killSessionById(current.id);
        // stop() revokes this continuation even if the same runtime has since started again.
        if (!active()) return;
        this.pins.reset("assistant");
        await this.pins.tick();
        this.lastVerdict = undefined;
      });
    }).finally(() => { this.tickFlight = undefined; });
  }
  /** The assistant's current incarnation, whether its harness is resting, and whether it is waiting on the user. */
  private async sample(): Promise<{ id: string; idle: boolean; needsInput: boolean; token: string; programAt?: number; fallback?: { screen: string; quietMs: number; outputSequence?: string } } | undefined> {
    const { observeDashboardSessions } = await import("./session-observation.js");
    const service = this.ctx.assistantService;
    if (!service.enabled || !this.homeIsLocal()) return undefined;
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
    return { id: session.identity.wolfpackSessionId, idle: adapter.isIdle(facts), needsInput: adapter.needsInput(facts), ...(screen !== undefined && { fallback: { screen, quietMs, outputSequence: fact.outputSequence } }), programAt: fact.programStatus?.updatedAtMs, token: fact.programStatus ? `program:${fact.programStatus.updatedAtMs}` : session.runtimeState.changedAt };
  }
}
