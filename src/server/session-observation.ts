import { randomUUID } from "node:crypto";
import type { SessionMeta } from "../session-meta-contract.js";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_FRESHNESS, AGENT_STATUS_STATE } from "../agent-status-contract.js";
import type { AgentStatusState } from "../agent-status-contract.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import { createLogger, errMsg } from "../log.js";
import { reduceActivityObservation } from "../session-activity.js";
import { QUIET_ALERT_KIND, QUIET_SUPPRESSION_REASON, reduceQuietAlertPolicy } from "../quiet-alert-policy.js";
import {
  onQuietAlertPolicyInvalidation,
  quietAlertPolicyEpoch,
} from "../quiet-alert-policy-invalidation.js";
import type {
  QuietAlertFact,
  QuietAlertKindFields,
  QuietAlertPolicyState,
  QuietSuppression,
} from "../quiet-alert-policy.js";
import type {
  SessionActivityHistory,
  SessionActivityObservation,
  SessionActivityObservationInput,
  SessionActivityReduction,
} from "../session-activity.js";
import type { TriageStatus } from "../triage.js";
import {
  agentStatusSources,
  readLocalStatusManifest,
  flushAgentRuntimeStateForShutdown,
  getAgentRuntimeStateStore,
  programStatusSource,
} from "./agent-status.js";
import type { AgentRuntimeState, AgentRuntimeStateStore } from "./agent-status.js";
import { defaultServerContext, type ServerContext } from "./context.js";
import type { SessionBackend, SessionListFact } from "./backend.js";
import {
  checkSessionTransitions,
  clearQuietAlertRecipientSnapshots,
  forgetQuietAlertRecipientSnapshots,
  getSubscriptionCount,
  pruneQuietAlertRecipientSnapshots,
  recordQuietAlertEmission,
} from "./push.js";
import { loadSettings } from "./project-settings-routes.js";
import type { PublicSessionIdentity } from "./session-identity.js";
import { WOLFPACK_EVENT_KIND } from "../events-contract.js";
import type { EventBus } from "../event-bus.js";
let notificationContext: ServerContext = defaultServerContext;
import { onProgramStatusChanged } from "./program-status-signal.js";

const log = createLogger("session-observation");
const SESSION_NOTIFICATION_OBSERVATION_INTERVAL_MS = 5_000;
const DASHBOARD_OBSERVATION_CACHE_TTL_MS = process.env.WOLFPACK_TEST ? 0 : 500;

interface ActivityFingerprint {
  readonly outputSequence?: string;
  readonly rendered?: string;
}

type RenderedCapture =
  | { readonly available: true; readonly rendered: string }
  | { readonly available: false };

interface RenderedFingerprintFlight {
  readonly token: object;
  readonly policyEpoch: number;
  readonly outputSequence?: string;
  readonly observedAtMs: number;
  readonly observedAt: string;
  readonly promise: Promise<RenderedCapture>;
  reduction?: SessionActivityReduction;
}

interface RenderedActivitySample {
  readonly token: object;
  readonly flight: RenderedFingerprintFlight;
  readonly capture: RenderedCapture;
  readonly rendered: string | undefined;
}

interface ObservationAuthority {
  readonly policyEpoch: number;
  readonly id: number;
}

const activityHistory = new Map<string, SessionActivityHistory>();
const quietAlertHistory = new Map<string, QuietAlertPolicyState>();
const activityContinuityTokens = new Map<string, object>();
const dashboardFingerprints = new Map<string, ActivityFingerprint>();
const notificationFingerprints = new Map<string, ActivityFingerprint>();
const renderedFingerprintFlights = new Map<string, RenderedFingerprintFlight>();
/**
 * Last rendered screen folded into the shared runtime-state store, per
 * session. Observer fingerprints are consumer-local (each observer's triage),
 * but the store is shared: comparing against this canonical screen keeps a
 * lagging observer from re-reporting output another observer already consumed.
 * Consumers of the capture flight that reported a change agree with it until
 * an unchanged observation is folded in.
 */
interface RuntimeRenderedFingerprint {
  readonly rendered: string;
  readonly flight?: RenderedFingerprintFlight;
  readonly changed: boolean;
}
const runtimeRenderedFingerprints = new Map<string, RuntimeRenderedFingerprint>();
/**
 * A full pass samples rendered output: the fallback output/idle state is
 * "changed since the previous full pass", so only the regular cadence may run
 * one. A program-status pass re-reads lifecycle and OSC 7501 state and reuses
 * every rendered/activity fingerprint untouched.
 */
type ObservationPass = "full" | "program-status";
let sessionNotificationObservationTimer: ReturnType<typeof setInterval> | null = null;
let sessionNotificationObservationPromise: Promise<readonly ObservedSessionSummary[]> | null = null;
let peerNotificationObservationPromise: Promise<void> | null = null;
let sessionNotificationObservationPass: ObservationPass = "full";
let dashboardObservationPromise: Promise<readonly ObservedSessionSummary[]> | null = null;
let dashboardObservationCache: {
  readonly expiresAt: number;
  readonly sessions: readonly ObservedSessionSummary[];
} | null = null;

onQuietAlertPolicyInvalidation(() => {
  quietAlertHistory.clear();
  dashboardObservationCache = null;
});

interface KnownSessionSummary {
  readonly name: string;
  readonly lastLine: string;
  readonly identity?: PublicSessionIdentity;
}

/** Descendant generations searched for a busy child; bounds cycles and fan-out. */
const QUIET_SUPPRESSION_MAX_DEPTH = 8;
/** Descendant runtime states that count as still working on the parent's behalf. */
const BUSY_DESCENDANT_STATES: ReadonlySet<AgentStatusState> = new Set([
  AGENT_STATUS_STATE.WORKING,
  AGENT_STATUS_STATE.RUNNING,
  AGENT_STATUS_STATE.OUTPUT,
]);

interface ObservedSessionSummary {
  readonly name: string;
  readonly lastLine: string;
  readonly meta?: SessionMeta;
  readonly footer?: string;
  readonly triage: TriageStatus;
  readonly runtimeState: AgentRuntimeState;
  readonly activity: SessionActivityObservation;
  readonly quietAlert?: QuietAlertFact;
  readonly quietSuppressedBy?: QuietSuppression;
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

/**
 * A session observed in this collection, before its quiet episode is reduced.
 * Quiet eligibility runs in one synchronous pass over the whole collection.
 */
interface PendingSessionObservation {
  readonly sessionKey: string;
  readonly observedAtMs: number;
  /** Absent when this observation says nothing about quiet continuity. */
  readonly quietContinuity?: "fresh" | "lost";
  readonly alive: boolean;
  readonly summary: Omit<ObservedSessionSummary, "quietAlert" | "quietSuppressedBy">;
}

interface SessionObservation {
  readonly sessions: readonly ObservedSessionSummary[];
  readonly unreliableSessionKeys: ReadonlySet<string>;
  readonly authoritative: boolean;
}

function withoutQuietAlerts(sessions: readonly ObservedSessionSummary[]): readonly ObservedSessionSummary[] {
  return sessions.map(({ quietAlert: _quietAlert, quietSuppressedBy: _quietSuppressedBy, ...session }) => session);
}

const knownSessionSummaries = new Map<string, KnownSessionSummary>();
let nextObservationOwnership = 0;
let latestAuthoritativeObservation = 0;

const SESSION_PREVIEW_MAX_CHARS = 240;

function cleanPreviewLine(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function legacyTerminalPreviewLine(rendered: string | undefined): string {
  const last = cleanPreviewLine(rendered?.split("\n").at(-1) ?? "");
  return Array.from(last).slice(0, SESSION_PREVIEW_MAX_CHARS).join("");
}

// Only recognizable chrome is skipped. These patterns never classify prompts,
// activity, or runtime state; unknown harness text remains visible.
const TERMINAL_CHROME = [
  /^[↑↓]\d/, // pi token/cost/model footer
  /^~\/.*\(.*\)$/, // pi cwd/branch
  /^[-─]{8,}/,
  /^[\u2500-\u257f\s]+$/, // box-drawing-only rules
  /^[❯>▏▎▍▌▋▊▉█│┃]+$/, // empty input/cursor only
  /^⏵⏵ auto mode on \(shift\+tab to cycle\)/, // claude
  /^✔ Update installed · \/restart to apply$/,
];

function parsePiFooter(line: string): SessionMeta | undefined {
  const model = /\s{2,}(?:\([\w-]+\)\s+)?([\w.-]+)\s+•\s+([\w]+(?:\s+[\w]+)*)$/.exec(line);
  // CH is cache-hit rate, NOT context. Only the %/limit token is context.
  const context = /(\d+(?:\.\d+)?)%\/(\d+(?:\.\d+)?)([kM])\b/.exec(line);
  const cost = /\$(\d+(?:\.\d+)?)(?:\s+\(([\w-]+)\))?/.exec(line);
  if (!model && !context && !cost) return undefined;
  return {
    ...(model && { model: model[1], reasoning: model[2] }),
    ...(context && { contextPct: Number(context[1]), contextLimit: Number(context[2]) * (context[3] === "M" ? 1_000_000 : 1000) }),
    ...(cost && { cost: Number(cost[1]), ...(cost[2] && { costTag: cost[2] }) }),
  };
}

export function terminalDisplayProjection(rendered: string | undefined): {
  readonly lastLine: string;
  readonly meta?: SessionMeta;
  readonly footer?: string;
} {
  const lines = (rendered ?? "").split("\n").map(cleanPreviewLine).filter(Boolean);
  // Pi renders cwd, stats, then optional extension statuses as one footer block.
  // Anchor only near the bottom; don't mistake earlier stats-like output for it.
  let piStatsIndex = -1;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index--) {
    if (/^[↑↓]\d/.test(lines[index]!)) { piStatsIndex = index; break; }
  }
  let piFooterStart = piStatsIndex;
  if (piStatsIndex > 0 && /^(?:~\/|\/|…)/.test(lines[piStatsIndex - 1]!)) piFooterStart--;
  let footer = piStatsIndex >= 0 ? lines[piStatsIndex] : undefined;
  let meta = footer ? parsePiFooter(footer) : undefined;
  let lastLine: string | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (piFooterStart >= 0 && index >= piFooterStart) continue;
    const line = lines[index]!;
    if (!TERMINAL_CHROME.some((pattern) => pattern.test(line))) {
      lastLine = Array.from(line).slice(0, 160).join("");
      break;
    }
    if (/^[↑↓]\d|^⏵⏵ |^✔ Update installed/.test(line)) {
      footer ??= line;
      if (/^[↑↓]\d/.test(line)) meta ??= parsePiFooter(line);
    }
  }
  return {
    lastLine: lastLine ?? legacyTerminalPreviewLine(rendered),
    ...(footer && { footer }),
    ...(meta && { meta }),
  };
}

export function lastTerminalPreviewLine(rendered: string | undefined): string {
  return terminalDisplayProjection(rendered).lastLine;
}

function renderedActivityFingerprint(pane: string): string {
  const normalized = pane
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
  return normalized;
}

function activityContinuityToken(sessionKey: string): object {
  let token = activityContinuityTokens.get(sessionKey);
  if (token === undefined) {
    token = {};
    activityContinuityTokens.set(sessionKey, token);
  }
  return token;
}

function reduceSessionActivity(
  sessionKey: string,
  input: SessionActivityObservationInput,
): SessionActivityReduction {
  const reduction = reduceActivityObservation(activityHistory.get(sessionKey), input);
  if (reduction.history) activityHistory.set(sessionKey, reduction.history);
  else activityHistory.delete(sessionKey);
  return reduction;
}

interface QuietAlertEligibility {
  readonly alert?: QuietAlertKindFields;
  readonly suppressed?: boolean;
}

function reduceSessionQuietAlert(
  sessionKey: string,
  sessionId: string | undefined,
  observedAtMs: number,
  continuity: "fresh" | "lost",
  renderedActivityAtMs?: number,
  episodeId?: string,
  eligibility: QuietAlertEligibility = {},
): QuietAlertFact | undefined {
  if (!sessionId) {
    quietAlertHistory.delete(sessionKey);
    return undefined;
  }
  const reduction = reduceQuietAlertPolicy(quietAlertHistory.get(sessionKey), {
    sessionId,
    observedAtMs,
    continuity,
    renderedActivityAt: renderedActivityAtMs,
    episodeId,
    policy: loadSettings().quietAlerts,
    ...eligibility,
  });
  if (reduction.state) quietAlertHistory.set(sessionKey, reduction.state);
  else quietAlertHistory.delete(sessionKey);
  if (reduction.event) recordQuietAlertEmission(sessionId, reduction.event.episodeId);
  return reduction.fact;
}

function createRenderedFingerprintFlight(
  backend: SessionBackend,
  sessionKey: string,
  name: string,
  outputSequence: string | undefined,
  token: object,
): RenderedFingerprintFlight {
  const observedAtMs = Date.now();
  const policyEpoch = quietAlertPolicyEpoch();
  const observedAt = new Date(observedAtMs).toISOString();
  const promise = backend.capturePane(name, { scrollbackLines: 0 })
    .then((pane) => ({ available: true as const, rendered: renderedActivityFingerprint(pane) }))
    .catch(() => ({ available: false as const }));
  return { token, policyEpoch, outputSequence, observedAtMs, observedAt, promise };
}

async function renderedActivitySample(
  backend: SessionBackend,
  sessionKey: string,
  name: string,
  outputSequence: string | undefined,
): Promise<RenderedActivitySample> {
  const token = activityContinuityToken(sessionKey);
  let flight = outputSequence === undefined ? undefined : renderedFingerprintFlights.get(sessionKey);
  if (flight?.outputSequence !== outputSequence || flight?.token !== token) flight = undefined;
  if (flight === undefined) {
    flight = createRenderedFingerprintFlight(backend, sessionKey, name, outputSequence, token);
    if (outputSequence !== undefined) renderedFingerprintFlights.set(sessionKey, flight);
  }
  const capture = await flight.promise;
  return {
    token: flight.token,
    flight,
    capture,
    rendered: activityContinuityTokens.get(sessionKey) === flight.token && capture.available
      ? capture.rendered
      : undefined,
  };
}

function reduceRenderedActivitySample(
  sessionKey: string,
  sessionId: string | undefined,
  sample: RenderedActivitySample,
  authority: ObservationAuthority,
): SessionActivityReduction | undefined {
  if (!ownsObservationAuthority(authority)) return undefined;
  if (sample.flight.reduction !== undefined) return sample.flight.reduction;
  const ownsContinuity = activityContinuityTokens.get(sessionKey) === sample.token;
  if (!ownsContinuity || !sample.capture.available) {
    const currentFlight = renderedFingerprintFlights.get(sessionKey);
    if (!sample.capture.available && currentFlight === sample.flight) {
      renderedFingerprintFlights.delete(sessionKey);
    }
    if (!sample.capture.available && ownsContinuity) {
      activityContinuityTokens.delete(sessionKey);
      reduceSessionQuietAlert(sessionKey, sessionId, sample.flight.observedAtMs, "lost");
    }
    const reduction = reduceActivityObservation(undefined, { alive: false, observedAt: sample.flight.observedAt });
    sample.flight.reduction = reduction;
    return reduction;
  }
  const reduction = reduceSessionActivity(sessionKey, {
    alive: true,
    observedAt: sample.flight.observedAt,
    rendered: sample.capture.rendered,
  });
  if (
    sample.flight.policyEpoch === authority.policyEpoch
    && authority.policyEpoch === quietAlertPolicyEpoch()
    && reduction.activity.lastRenderedActivityAt === sample.flight.observedAt
  ) {
    reduceSessionQuietAlert(sessionKey, sessionId, sample.flight.observedAtMs, "fresh", sample.flight.observedAtMs, randomUUID());
  }
  sample.flight.reduction = reduction;
  return reduction;
}

function retireRenderedActivitySample(sessionKey: string, sample: RenderedActivitySample): void {
  if (activityContinuityTokens.get(sessionKey) === sample.token) {
    activityContinuityTokens.delete(sessionKey);
  }
  if (renderedFingerprintFlights.get(sessionKey) === sample.flight) {
    renderedFingerprintFlights.delete(sessionKey);
  }
}

async function listAvailableSessionFacts(ctx: ServerContext): Promise<SessionListFact[] | undefined> {
  const backend = ctx.backend;
  if (ctx.supervisor && !ctx.supervisor.isBrokerAvailable()) return undefined;
  try {
    return await backend.listSessionFacts();
  } catch {
    return undefined;
  }
}

function beginObservationOwnership(): number {
  return ++nextObservationOwnership;
}

// A collection becomes authoritative when its list result completes. Its
// authority lasts only until a newer completed list claims the same policy epoch.
function claimObservationAuthority(observationOwnership: number, policyEpoch: number): ObservationAuthority | undefined {
  if (policyEpoch !== quietAlertPolicyEpoch() || observationOwnership < latestAuthoritativeObservation) return undefined;
  latestAuthoritativeObservation = observationOwnership;
  return { policyEpoch, id: observationOwnership };
}

function ownsObservationAuthority(authority: ObservationAuthority): boolean {
  return authority.policyEpoch === quietAlertPolicyEpoch()
    && authority.id === latestAuthoritativeObservation;
}

/**
 * Publish a runtime-state transition to event subscribers. The store is shared
 * by every observer, so each transition advances the sequence once. The first
 * observation of a session is a baseline, not a transition.
 */
function publishRuntimeTransition(
  name: string,
  sessionId: string | undefined,
  previousTransitionSequence: number | undefined,
  runtimeState: AgentRuntimeState,
  events: EventBus,
): void {
  if (previousTransitionSequence === undefined || runtimeState.transitionSequence === previousTransitionSequence) return;
  events.publishEvent({
    kind: WOLFPACK_EVENT_KIND.SESSION_STATE,
    session: name,
    ...(sessionId !== undefined && { sessionId }),
    state: runtimeState.state,
    label: runtimeState.label,
    transitionSequence: runtimeState.transitionSequence,
    ...(runtimeState.inputKind && { inputKind: runtimeState.inputKind }),
    // Only the program's own OSC 7501 text; other authorities' messages are
    // status diagnostics, not something the program said.
    ...(runtimeState.authority === AGENT_STATUS_AUTHORITY.PROGRAM && runtimeState.message
      && { message: runtimeState.message }),
  });
}

function observeUnavailableSessions(policyEpoch: number, observationOwnership: number, events: EventBus): SessionObservation {
  const authority = claimObservationAuthority(observationOwnership, policyEpoch);
  if (authority === undefined) {
    return { sessions: [], unreliableSessionKeys: new Set(), authoritative: false };
  }
  activityHistory.clear();
  quietAlertHistory.clear();
  activityContinuityTokens.clear();
  dashboardFingerprints.clear();
  notificationFingerprints.clear();
  renderedFingerprintFlights.clear();
  runtimeRenderedFingerprints.clear();
  clearQuietAlertRecipientSnapshots(policyEpoch);
  const observedAt = new Date().toISOString();
  const store = getAgentRuntimeStateStore();
  const summariesBySessionKey = new Map<string, KnownSessionSummary>();
  for (const summary of knownSessionSummaries.values()) {
    summariesBySessionKey.set(summary.identity?.wolfpackSessionId ?? summary.name, summary);
  }
  for (const sessionKey of Object.keys(store.snapshot().sessions)) {
    if (!summariesBySessionKey.has(sessionKey)) summariesBySessionKey.set(sessionKey, { name: sessionKey, lastLine: "" });
  }
  const sessions = Array.from(summariesBySessionKey.entries()).map<ObservedSessionSummary>(([sessionKey, { name, lastLine, identity }]) => {
    const previous = store.get(sessionKey);
    const runtimeState = store.reduce({
      sessionKey,
      broker: { state: "unavailable", observedAt },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt, preview: lastLine },
      currentRun: {
        runId: identity?.wolfpackSessionId ?? previous?.runId,
        runOrder: identity?.createdAt ? Date.parse(identity.createdAt) : previous?.runOrder,
      },
    }, { persist: false });
    publishRuntimeTransition(name, identity?.wolfpackSessionId, previous?.transitionSequence, runtimeState, events);
    return {
      name,
      lastLine,
      triage: "idle" as TriageStatus,
      runtimeState,
      activity: { freshness: "unknown", observedAt, display: "activity unavailable" },
      ...(identity && { identity }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  store.flush();
  return { sessions, unreliableSessionKeys: new Set(summariesBySessionKey.keys()), authoritative: true };
}

function staleSessionProjection(
  sessions: readonly Pick<ObservedSessionSummary, "name" | "identity">[],
): SessionObservation {
  const observedAt = new Date().toISOString();
  const store = getAgentRuntimeStateStore();
  const unreliableSessionKeys = new Set<string>();
  const projection = sessions.flatMap<ObservedSessionSummary>((session) => {
    const known = knownSessionSummaries.get(session.name);
    const identity = known?.identity ?? session.identity;
    const sessionKey = identity?.wolfpackSessionId ?? session.name;
    unreliableSessionKeys.add(sessionKey);
    const runtimeState = store.get(sessionKey);
    if (runtimeState === undefined) return [];
    return [{
      name: session.name,
      lastLine: known?.lastLine ?? "",
      triage: "idle" as TriageStatus,
      runtimeState,
      activity: reduceActivityObservation(undefined, { alive: false, observedAt }).activity,
      ...(identity && { identity }),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { sessions: projection, unreliableSessionKeys, authoritative: false };
}

async function observeSessionFact(
  backend: SessionBackend,
  fact: SessionListFact,
  fingerprints: Map<string, ActivityFingerprint>,
  store: AgentRuntimeStateStore,
  activeNames: Set<string>,
  activeSessionKeys: Set<string>,
  unreliableSessionKeys: Set<string>,
  authority: ObservationAuthority,
  pass: ObservationPass,
  events: EventBus,
): Promise<PendingSessionObservation | undefined> {
  if (!ownsObservationAuthority(authority)) return undefined;
  const name = fact.name;
  activeNames.add(name);
  const brokerState = fact.alive ? "alive" : "dead";
  const identity = fact.identity;
  const sessionKey = identity?.wolfpackSessionId ?? name;
  activeSessionKeys.add(sessionKey);

  // The output watermark is a cheap invalidation signal. Only materialize a
  // Ghostty snapshot when it advances; stable sessions do no terminal work.
  // A shared per-sequence flight prevents duplicate snapshot requests.
  const outputSequence = brokerOutputSequence(fact.outputSequence);
  const observedAtMs = Date.now();
  const observedAt = new Date(observedAtMs).toISOString();
  const previousFingerprint = fingerprints.get(sessionKey);
  const shouldSampleRenderedState = pass === "full" && brokerState === "alive" && (
    previousFingerprint === undefined
    || outputSequence === undefined
    || previousFingerprint.outputSequence !== outputSequence
  );
  // The project status manifest is read alongside the rendered sample so the
  // fs work adds no await point after the ownership check below.
  const [sample, statusManifest] = await Promise.all([
    shouldSampleRenderedState
      ? renderedActivitySample(backend, sessionKey, name, outputSequence)
      : undefined,
    identity?.projectPath ? readLocalStatusManifest(identity.projectPath) : undefined,
  ]);
  if (!ownsObservationAuthority(authority)) return undefined;
  const currentRendered = sample === undefined ? previousFingerprint?.rendered : sample.rendered;
  const rawOutputChanged = shouldSampleRenderedState
    && currentRendered !== undefined
    && previousFingerprint?.rendered !== undefined
    && currentRendered !== previousFingerprint.rendered;
  const previousRuntime = runtimeRenderedFingerprints.get(sessionKey);
  // A program-status pass carries the last full pass's output verdict: it is
  // not a new measurement, so the session's state cannot move by it.
  const runtimeOutputChanged = pass !== "full"
    ? previousRuntime?.changed === true
    : shouldSampleRenderedState
      && currentRendered !== undefined
      && previousRuntime !== undefined
      && (sample?.flight === previousRuntime.flight
        ? previousRuntime.changed
        : currentRendered !== previousRuntime.rendered);
  if (pass !== "full") {
    // Fingerprints belong to the cadence; leave them to the next full pass.
  } else if (brokerState !== "alive" || (shouldSampleRenderedState && currentRendered === undefined)) {
    // A liveness or capture gap breaks the observed continuity. The next
    // successful rendered sample is a baseline, not a fabricated transition.
    fingerprints.delete(sessionKey);
    runtimeRenderedFingerprints.delete(sessionKey);
    if (brokerState !== "alive") {
      activityContinuityTokens.delete(sessionKey);
      renderedFingerprintFlights.delete(sessionKey);
    } else if (sample?.capture.available) {
      retireRenderedActivitySample(sessionKey, sample);
    }
    if (shouldSampleRenderedState && currentRendered === undefined) unreliableSessionKeys.add(sessionKey);
  } else {
    fingerprints.set(sessionKey, { ...(outputSequence !== undefined && { outputSequence }), rendered: currentRendered });
    if (currentRendered !== undefined) {
      runtimeRenderedFingerprints.set(sessionKey, {
        rendered: currentRendered,
        flight: sample?.flight ?? previousRuntime?.flight,
        changed: runtimeOutputChanged,
      });
    }
  }
  const reduction = sample
    ? reduceRenderedActivitySample(sessionKey, identity?.wolfpackSessionId, sample, authority)
    : reduceSessionActivity(sessionKey, {
      alive: brokerState === "alive",
      observedAt,
      rendered: currentRendered,
    });
  if (!ownsObservationAuthority(authority) || reduction === undefined) return undefined;
  // Rendered activity is reduced once by its shared capture flight. Individual
  // dashboard/observer consumers can adopt that reduction, but a collection
  // retired while awaiting the capture cannot mutate its canonical state.
  const quietContinuity = brokerState === "alive" && currentRendered !== undefined
    ? "fresh" as const
    : brokerState !== "alive"
      ? "lost" as const
      : undefined;

  const triage: TriageStatus = rawOutputChanged ? "running" : "idle";
  const displayProjection = terminalDisplayProjection(currentRendered);
  const renderedPreview = displayProjection.lastLine;
  const lastLine = renderedPreview || knownSessionSummaries.get(name)?.lastLine || "";
  const previousTransitionSequence = store.get(sessionKey)?.transitionSequence;
  // The broker reports the root OSC 7501 record for this exact session, so it
  // is not gated on a project directory like the manifest/fallback sources.
  const programStatus = programStatusSource(fact.programStatus, {
    runId: identity?.wolfpackSessionId,
    observedAt,
  });
  const runtimeState = store.reduce({
    sessionKey,
    broker: { state: brokerState, observedAt },
    sources: [
      ...(programStatus ? [programStatus] : []),
      ...(statusManifest ? agentStatusSources(statusManifest, {
        state: runtimeOutputChanged ? AGENT_STATUS_STATE.OUTPUT : AGENT_STATUS_STATE.IDLE,
        stale: false,
        observedAt,
      }) : []),
    ],
    // Keep the unfiltered legacy preview on this existing runtime input;
    // display-only footer skipping and metadata must not become status evidence.
    fallback: { rawOutputChanged: runtimeOutputChanged, observedAt, preview: legacyTerminalPreviewLine(currentRendered) },
    currentRun: {
      runId: identity?.wolfpackSessionId,
      runOrder: identity?.createdAt ? Date.parse(identity.createdAt) : undefined,
    },
  }, { persist: false });
  publishRuntimeTransition(name, identity?.wolfpackSessionId, previousTransitionSequence, runtimeState, events);
  const summary = {
    ...displayProjection,
    name,
    lastLine,
    triage,
    runtimeState,
    activity: reduction.activity,
    ...(outputSequence !== undefined && { outputSequence }),
    ...(identity && { identity }),
  };
  knownSessionSummaries.set(name, { name, lastLine, ...(identity && { identity }) });
  return {
    sessionKey,
    observedAtMs,
    ...(quietContinuity && { quietContinuity }),
    alive: brokerState === "alive",
    summary,
  };
}

/** The program itself says it waits on the user; that alert is never withheld. */
function needsInputAlert(runtimeState: AgentRuntimeState): QuietAlertKindFields | undefined {
  if (runtimeState.state !== AGENT_STATUS_STATE.NEEDS_INPUT || runtimeState.authority !== AGENT_STATUS_AUTHORITY.PROGRAM) {
    return undefined;
  }
  return {
    kind: QUIET_ALERT_KIND.NEEDS_INPUT,
    ...(runtimeState.inputKind && { inputKind: runtimeState.inputKind }),
  };
}

/**
 * A live descendant is busy while fresh status says it works or prints, or
 * while its screen changed more recently than the parent's quiet window.
 */
function busyDescendant(pending: PendingSessionObservation, quietSinceMs: number): boolean {
  if (!pending.alive) return false;
  const { runtimeState, activity } = pending.summary;
  if (
    BUSY_DESCENDANT_STATES.has(runtimeState.state)
    && runtimeState.freshness === AGENT_STATUS_FRESHNESS.FRESH
    && !runtimeState.stale
  ) return true;
  const renderedAtMs = activity.lastRenderedActivityAt === undefined ? NaN : Date.parse(activity.lastRenderedActivityAt);
  return renderedAtMs > quietSinceMs;
}

interface ChildObservation {
  readonly sessionId: string;
  readonly pending: PendingSessionObservation;
}

/** Nearest busy descendant by `parentSession` links, breadth first and depth bounded. */
function findBusyDescendant(
  parentId: string,
  childrenByParentId: ReadonlyMap<string, readonly ChildObservation[]>,
  quietSinceMs: number,
): QuietSuppression | undefined {
  const visited = new Set([parentId]);
  let generation = [parentId];
  for (let depth = 1; depth <= QUIET_SUPPRESSION_MAX_DEPTH && generation.length > 0; depth++) {
    const next: string[] = [];
    for (const id of generation) {
      for (const { sessionId, pending } of childrenByParentId.get(id) ?? []) {
        if (visited.has(sessionId)) continue;
        visited.add(sessionId);
        if (busyDescendant(pending, quietSinceMs)) {
          return { reason: QUIET_SUPPRESSION_REASON.WAITING_ON_CHILD, sessionId, session: pending.summary.name };
        }
        next.push(sessionId);
      }
    }
    generation = next;
  }
  return undefined;
}

/**
 * Reduces each observed session's quiet episode. Synchronous, so it runs under
 * one observation authority for the whole collection, which lets a parent's
 * alert see its delegated children. A due `quiet` alert waits while a
 * descendant is busy; `needs-input` from the program's own status wins over
 * that, because the parent is waiting on the user, not the child.
 */
function reduceCollectedQuietAlerts(
  pending: readonly PendingSessionObservation[],
): ObservedSessionSummary[] {
  const childrenByParentId = new Map<string, ChildObservation[]>();
  for (const entry of pending) {
    const identity = entry.summary.identity;
    const parentId = identity?.parentSession?.wolfpackSessionId;
    if (identity === undefined || parentId === undefined) continue;
    const child = { sessionId: identity.wolfpackSessionId, pending: entry };
    const siblings = childrenByParentId.get(parentId);
    if (siblings) siblings.push(child);
    else childrenByParentId.set(parentId, [child]);
  }
  const quietAfterMs = loadSettings().quietAlerts.quietAfterSeconds * 1_000;
  return pending.map(({ sessionKey, observedAtMs, quietContinuity, summary }) => {
    if (quietContinuity === undefined) return summary;
    const sessionId = summary.identity?.wolfpackSessionId;
    const alert = quietContinuity === "fresh" ? needsInputAlert(summary.runtimeState) : undefined;
    const busy = quietContinuity === "fresh" && alert === undefined && sessionId !== undefined
      ? findBusyDescendant(sessionId, childrenByParentId, observedAtMs - quietAfterMs)
      : undefined;
    const quietAlert = reduceSessionQuietAlert(sessionKey, sessionId, observedAtMs, quietContinuity, undefined, undefined, {
      ...(alert && { alert }),
      ...(busy && { suppressed: true }),
    });
    // Only a due episode is withheld; one still inside its window is just pending.
    const episode = quietAlertHistory.get(sessionKey);
    const withheld = busy !== undefined && episode !== undefined && !episode.emitted && observedAtMs >= episode.eligibleAtMs;
    return {
      ...summary,
      ...(quietAlert && { quietAlert }),
      ...(withheld && { quietSuppressedBy: busy }),
    };
  });
}

function pruneSessionObservationState(
  fingerprints: Map<string, ActivityFingerprint>,
  activeSessionKeys: ReadonlySet<string>,
  activeNames: ReadonlySet<string>,
  store: AgentRuntimeStateStore,
  authority: ObservationAuthority,
): void {
  if (!ownsObservationAuthority(authority)) return;
  for (const key of fingerprints.keys()) {
    if (!activeSessionKeys.has(key)) fingerprints.delete(key);
  }
  for (const key of activityHistory.keys()) {
    if (!activeSessionKeys.has(key)) activityHistory.delete(key);
  }
  for (const key of quietAlertHistory.keys()) {
    if (!activeSessionKeys.has(key)) quietAlertHistory.delete(key);
  }
  for (const key of activityContinuityTokens.keys()) {
    if (!activeSessionKeys.has(key)) activityContinuityTokens.delete(key);
  }
  for (const key of renderedFingerprintFlights.keys()) {
    if (!activeSessionKeys.has(key)) renderedFingerprintFlights.delete(key);
  }
  for (const key of runtimeRenderedFingerprints.keys()) {
    if (!activeSessionKeys.has(key)) runtimeRenderedFingerprints.delete(key);
  }
  for (const key of knownSessionSummaries.keys()) {
    if (!activeNames.has(key)) knownSessionSummaries.delete(key);
  }
  store.prune(activeSessionKeys, { persist: false });
  store.flush();
  pruneQuietAlertRecipientSnapshots(activeSessionKeys, authority.policyEpoch);
}

async function collectSessionObservation(
  fingerprints: Map<string, ActivityFingerprint>,
  policyEpoch = quietAlertPolicyEpoch(),
  observationOwnership = beginObservationOwnership(),
  pass: ObservationPass = "full",
  ctx: ServerContext = notificationContext,
): Promise<SessionObservation> {
  const backend = ctx.backend;
  const sessionFacts = await listAvailableSessionFacts(ctx);
  if (!sessionFacts) return observeUnavailableSessions(policyEpoch, observationOwnership, ctx.events);
  const store = getAgentRuntimeStateStore();
  const authority = claimObservationAuthority(observationOwnership, policyEpoch);
  if (authority === undefined) return staleSessionProjection(sessionFacts);

  const activeNames = new Set<string>();
  const activeSessionKeys = new Set<string>();
  const unreliableSessionKeys = new Set<string>();
  const observedSessions = await Promise.all(sessionFacts.map((fact) => observeSessionFact(
    backend,
    fact,
    fingerprints,
    store,
    activeNames,
    activeSessionKeys,
    unreliableSessionKeys,
    authority,
    pass,
    ctx.events,
  )));
  if (!ownsObservationAuthority(authority)) return staleSessionProjection(sessionFacts);

  const sessions = reduceCollectedQuietAlerts(
    observedSessions.filter((session): session is PendingSessionObservation => session !== undefined),
  );
  sessions.sort((a, b) => a.name.localeCompare(b.name));
  if (pass === "full") pruneSessionObservationState(fingerprints, activeSessionKeys, activeNames, store, authority);
  return { sessions, unreliableSessionKeys, authoritative: ownsObservationAuthority(authority) };
}

export async function observeDashboardSessions(ctx: ServerContext = defaultServerContext): Promise<readonly ObservedSessionSummary[]> {
  const now = Date.now();
  if (dashboardObservationCache && now < dashboardObservationCache.expiresAt) {
    return dashboardObservationCache.sessions;
  }
  if (dashboardObservationPromise) return dashboardObservationPromise;
  const policyEpoch = quietAlertPolicyEpoch();
  const observationOwnership = beginObservationOwnership();
  const authority = { policyEpoch, id: observationOwnership } as const;
  dashboardObservationPromise = collectSessionObservation(dashboardFingerprints, policyEpoch, observationOwnership, "full", ctx)
    .then((observation) => {
      if (policyEpoch !== quietAlertPolicyEpoch()) return withoutQuietAlerts(observation.sessions);
      if (!observation.authoritative || !ownsObservationAuthority(authority)) {
        return staleSessionProjection(observation.sessions).sessions;
      }
      dashboardObservationCache = {
        expiresAt: Date.now() + DASHBOARD_OBSERVATION_CACHE_TTL_MS,
        sessions: observation.sessions,
      };
      return observation.sessions;
    })
    .finally(() => {
      dashboardObservationPromise = null;
    });
  return dashboardObservationPromise;
}

function schedulePeerNotificationObservation(): void {
  if (peerNotificationObservationPromise || getSubscriptionCount() === 0) return;
  // Peer collection has its own flight, not its own delivery machinery. Even a
  // stalled network map must not hold the next local observation behind it.
  peerNotificationObservationPromise = (async () => {
    const { observePeerNotifications } = await import("./peer-notifications.ts");
    for (const peer of await observePeerNotifications()) {
      await checkSessionTransitions(peer.sessions, quietAlertPolicyEpoch(), () => getSubscriptionCount() > 0, peer.machine);
    }
  })().catch((error: unknown) => {
    log.warn("peer notification relay failed", { error: errMsg(error) });
  }).finally(() => {
    peerNotificationObservationPromise = null;
  });
}

async function runSessionNotificationObservation(pass: ObservationPass = "full"): Promise<readonly ObservedSessionSummary[]> {
  if (getSubscriptionCount() === 0 && notificationContext.events.eventSubscriberCount() === 0) return [];
  if (sessionNotificationObservationPromise) {
    if (pass !== "full" || sessionNotificationObservationPass === "full") return sessionNotificationObservationPromise;
    // A program-status pass does not measure output: a full pass asked for
    // while one is in flight runs after it instead of adopting its result.
    return sessionNotificationObservationPromise
      .catch(() => undefined)
      .then(() => runSessionNotificationObservation(pass));
  }
  sessionNotificationObservationPass = pass;
  sessionNotificationObservationPromise = (async () => {
    const policyEpoch = quietAlertPolicyEpoch();
    const observationOwnership = beginObservationOwnership();
    const authority = { policyEpoch, id: observationOwnership } as const;
    const observation = await collectSessionObservation(notificationFingerprints, policyEpoch, observationOwnership, pass);
    if (policyEpoch !== quietAlertPolicyEpoch()) return withoutQuietAlerts(observation.sessions);
    if (!observation.authoritative || !ownsObservationAuthority(authority)) {
      return staleSessionProjection(observation.sessions).sessions;
    }
    await checkSessionTransitions(observation.sessions.map((session) => {
      const sessionKey = session.identity?.wolfpackSessionId ?? session.name;
      return {
        ...session,
        notificationEligible: !observation.unreliableSessionKeys.has(sessionKey),
      };
    }), policyEpoch, () => ownsObservationAuthority(authority));
    if (pass === "full") schedulePeerNotificationObservation();
    if (policyEpoch !== quietAlertPolicyEpoch()) return withoutQuietAlerts(observation.sessions);
    return ownsObservationAuthority(authority)
      ? observation.sessions
      : staleSessionProjection(observation.sessions).sessions;
  })().finally(() => {
    sessionNotificationObservationPromise = null;
  });
  return sessionNotificationObservationPromise;
}

function scheduleSessionNotificationObservation(): void {
  runSessionNotificationObservation().catch((error: unknown) => {
    log.warn("session notification observation failed", { error: errMsg(error) });
  });
}

/**
 * A broker program status change starts a program-status pass after this
 * delay instead of waiting up to the 5s poll. Signals inside the window (a
 * burst, or several sessions at once) share one pass; the broker already
 * rate-limits each session's events, so this window only batches across
 * sessions. The refresh lives with the observer: nothing is scheduled while it
 * is stopped, and a refresh queued behind an in-flight pass is dropped when
 * the observer stops before that pass ends.
 */
const PROGRAM_STATUS_REFRESH_DELAY_MS = 50;
let programStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function requestProgramStatusRefresh(): void {
  dashboardObservationCache = null;
  if (sessionNotificationObservationTimer === null || programStatusRefreshTimer) return;
  programStatusRefreshTimer = setTimeout(() => {
    programStatusRefreshTimer = null;
    // A pass already in flight may have listed sessions before the change;
    // run a fresh one after it rather than joining it.
    void Promise.resolve(sessionNotificationObservationPromise)
      .catch(() => undefined)
      .then(() => {
        if (sessionNotificationObservationTimer === null) return;
        runSessionNotificationObservation("program-status").catch((error: unknown) => {
          log.warn("program status observation failed", { error: errMsg(error) });
        });
      });
  }, PROGRAM_STATUS_REFRESH_DELAY_MS);
}

onProgramStatusChanged(requestProgramStatusRefresh);

function cancelProgramStatusRefresh(): void {
  if (programStatusRefreshTimer) clearTimeout(programStatusRefreshTimer);
  programStatusRefreshTimer = null;
}

export function startSessionNotificationObserver(ctx: ServerContext = defaultServerContext): void {
  notificationContext = ctx;
  if (sessionNotificationObservationTimer) return;
  scheduleSessionNotificationObservation();
  sessionNotificationObservationTimer = setInterval(
    scheduleSessionNotificationObservation,
    SESSION_NOTIFICATION_OBSERVATION_INTERVAL_MS,
  );
}

export async function stopSessionNotificationObserver(): Promise<void> {
  cancelProgramStatusRefresh();
  if (sessionNotificationObservationTimer) {
    clearInterval(sessionNotificationObservationTimer);
    sessionNotificationObservationTimer = null;
  }
  // Let already-running collections finish their reductions before draining.
  await Promise.allSettled([dashboardObservationPromise, sessionNotificationObservationPromise]);
  // A finishing local pass can have started a peer flight while being drained.
  await Promise.allSettled([peerNotificationObservationPromise]);
  await flushAgentRuntimeStateForShutdown();
}

export function forgetSessionObservation(sessionId: string, sessionName: string): void {
  dashboardObservationCache = null;
  activityHistory.delete(sessionId);
  activityHistory.delete(sessionName);
  quietAlertHistory.delete(sessionId);
  quietAlertHistory.delete(sessionName);
  activityContinuityTokens.delete(sessionId);
  activityContinuityTokens.delete(sessionName);
  dashboardFingerprints.delete(sessionId);
  dashboardFingerprints.delete(sessionName);
  notificationFingerprints.delete(sessionId);
  notificationFingerprints.delete(sessionName);
  renderedFingerprintFlights.delete(sessionId);
  renderedFingerprintFlights.delete(sessionName);
  runtimeRenderedFingerprints.delete(sessionId);
  runtimeRenderedFingerprints.delete(sessionName);
  forgetQuietAlertRecipientSnapshots([sessionId, sessionName]);
}

export function resetNotificationObservation(): void {
  notificationFingerprints.clear();
}

export function __resetSessionObservationForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionObservationForTests is test-only");
  cancelProgramStatusRefresh();
  activityHistory.clear();
  quietAlertHistory.clear();
  activityContinuityTokens.clear();
  dashboardFingerprints.clear();
  notificationFingerprints.clear();
  dashboardObservationPromise = null;
  dashboardObservationCache = null;
  renderedFingerprintFlights.clear();
  runtimeRenderedFingerprints.clear();
  knownSessionSummaries.clear();
  nextObservationOwnership = 0;
  latestAuthoritativeObservation = 0;
}

export async function __runSessionNotificationObservationForTests(): Promise<readonly ObservedSessionSummary[]> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__runSessionNotificationObservationForTests is test-only");
  return runSessionNotificationObservation();
}
