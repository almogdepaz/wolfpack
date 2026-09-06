import { randomUUID } from "node:crypto";
import { AGENT_STATUS_STATE } from "../agent-status-contract.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import { createLogger, errMsg } from "../log.js";
import { reduceActivityObservation } from "../session-activity.js";
import { reduceQuietAlertPolicy } from "../quiet-alert-policy.js";
import {
  onQuietAlertPolicyInvalidation,
  quietAlertPolicyEpoch,
} from "../quiet-alert-policy-invalidation.js";
import type { QuietAlertFact, QuietAlertPolicyState } from "../quiet-alert-policy.js";
import type {
  SessionActivityHistory,
  SessionActivityObservation,
  SessionActivityObservationInput,
  SessionActivityReduction,
} from "../session-activity.js";
import type { TriageStatus } from "../triage.js";
import {
  collectAgentStatusSources,
  getAgentRuntimeStateStore,
} from "./agent-status.js";
import type { AgentRuntimeState, AgentRuntimeStateStore } from "./agent-status.js";
import { getBackend, getRouter } from "./backend.js";
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
let sessionNotificationObservationTimer: ReturnType<typeof setInterval> | null = null;
let sessionNotificationObservationPromise: Promise<readonly ObservedSessionSummary[]> | null = null;
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

interface ObservedSessionSummary {
  readonly name: string;
  readonly lastLine: string;
  readonly triage: TriageStatus;
  readonly runtimeState: AgentRuntimeState;
  readonly activity: SessionActivityObservation;
  readonly quietAlert?: QuietAlertFact;
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

interface SessionObservation {
  readonly sessions: readonly ObservedSessionSummary[];
  readonly unreliableSessionKeys: ReadonlySet<string>;
  readonly authoritative: boolean;
}

function withoutQuietAlerts(sessions: readonly ObservedSessionSummary[]): readonly ObservedSessionSummary[] {
  return sessions.map(({ quietAlert: _quietAlert, ...session }) => session);
}

const knownSessionSummaries = new Map<string, KnownSessionSummary>();
let nextObservationOwnership = 0;
let latestAuthoritativeObservation = 0;

const SESSION_PREVIEW_MAX_CHARS = 240;

export function lastTerminalPreviewLine(rendered: string | undefined): string {
  if (!rendered) return "";
  const lines = rendered.split("\n");
  const last = (lines.at(-1) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(last).slice(0, SESSION_PREVIEW_MAX_CHARS).join("");
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

function reduceSessionQuietAlert(
  sessionKey: string,
  sessionId: string | undefined,
  observedAtMs: number,
  continuity: "fresh" | "lost",
  renderedActivityAtMs?: number,
  episodeId?: string,
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

async function listAvailableSessionFacts(backend: SessionBackend): Promise<SessionListFact[] | undefined> {
  const router = getRouter();
  if (backend === router && !router.isBrokerAvailable()) return undefined;
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

function observeUnavailableSessions(policyEpoch: number, observationOwnership: number): SessionObservation {
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
): Promise<ObservedSessionSummary | undefined> {
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
  const shouldSampleRenderedState = brokerState === "alive" && (
    previousFingerprint === undefined
    || outputSequence === undefined
    || previousFingerprint.outputSequence !== outputSequence
  );
  const sample = shouldSampleRenderedState
    ? await renderedActivitySample(backend, sessionKey, name, outputSequence)
    : undefined;
  if (!ownsObservationAuthority(authority)) return undefined;
  const currentRendered = sample === undefined ? previousFingerprint?.rendered : sample.rendered;
  const rawOutputChanged = shouldSampleRenderedState
    && currentRendered !== undefined
    && previousFingerprint?.rendered !== undefined
    && currentRendered !== previousFingerprint.rendered;
  if (brokerState !== "alive" || (shouldSampleRenderedState && currentRendered === undefined)) {
    // A liveness or capture gap breaks the observed continuity. The next
    // successful rendered sample is a baseline, not a fabricated transition.
    fingerprints.delete(sessionKey);
    if (brokerState !== "alive") {
      activityContinuityTokens.delete(sessionKey);
      renderedFingerprintFlights.delete(sessionKey);
    } else if (sample?.capture.available) {
      retireRenderedActivitySample(sessionKey, sample);
    }
    if (shouldSampleRenderedState && currentRendered === undefined) unreliableSessionKeys.add(sessionKey);
  } else {
    fingerprints.set(sessionKey, { ...(outputSequence !== undefined && { outputSequence }), rendered: currentRendered });
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
  const quietAlert = brokerState === "alive" && currentRendered !== undefined
    ? reduceSessionQuietAlert(sessionKey, identity?.wolfpackSessionId, observedAtMs, "fresh")
    : brokerState !== "alive"
      ? reduceSessionQuietAlert(sessionKey, identity?.wolfpackSessionId, observedAtMs, "lost")
      : undefined;
  if (!ownsObservationAuthority(authority)) return undefined;

  const triage: TriageStatus = rawOutputChanged ? "running" : "idle";
  const renderedPreview = lastTerminalPreviewLine(currentRendered);
  const lastLine = renderedPreview || knownSessionSummaries.get(name)?.lastLine || "";
  const runtimeState = store.reduce({
    sessionKey,
    broker: { state: brokerState, observedAt },
    sources: identity?.projectPath ? collectAgentStatusSources(identity.projectPath, {
      state: rawOutputChanged ? AGENT_STATUS_STATE.OUTPUT : AGENT_STATUS_STATE.IDLE,
      stale: false,
      observedAt,
    }) : [],
    fallback: { rawOutputChanged, observedAt, preview: lastLine },
    currentRun: {
      runId: identity?.wolfpackSessionId,
      runOrder: identity?.createdAt ? Date.parse(identity.createdAt) : undefined,
    },
  }, { persist: false });
  const summary = {
    name,
    lastLine,
    triage,
    runtimeState,
    activity: reduction.activity,
    ...(quietAlert && { quietAlert }),
    ...(outputSequence !== undefined && { outputSequence }),
    ...(identity && { identity }),
  };
  knownSessionSummaries.set(name, { name, lastLine, ...(identity && { identity }) });
  return summary;
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
): Promise<SessionObservation> {
  const backend = getBackend();
  const sessionFacts = await listAvailableSessionFacts(backend);
  if (!sessionFacts) return observeUnavailableSessions(policyEpoch, observationOwnership);
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
  )));
  if (!ownsObservationAuthority(authority)) return staleSessionProjection(sessionFacts);

  const sessions = observedSessions.filter((session): session is ObservedSessionSummary => session !== undefined);
  sessions.sort((a, b) => a.name.localeCompare(b.name));
  pruneSessionObservationState(fingerprints, activeSessionKeys, activeNames, store, authority);
  return { sessions, unreliableSessionKeys, authoritative: ownsObservationAuthority(authority) };
}

export async function observeDashboardSessions(): Promise<readonly ObservedSessionSummary[]> {
  const now = Date.now();
  if (dashboardObservationCache && now < dashboardObservationCache.expiresAt) {
    return dashboardObservationCache.sessions;
  }
  if (dashboardObservationPromise) return dashboardObservationPromise;
  const policyEpoch = quietAlertPolicyEpoch();
  const observationOwnership = beginObservationOwnership();
  const authority = { policyEpoch, id: observationOwnership } as const;
  dashboardObservationPromise = collectSessionObservation(dashboardFingerprints, policyEpoch, observationOwnership)
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

async function runSessionNotificationObservation(): Promise<readonly ObservedSessionSummary[]> {
  if (getSubscriptionCount() === 0) return [];
  if (sessionNotificationObservationPromise) return sessionNotificationObservationPromise;
  sessionNotificationObservationPromise = (async () => {
    const policyEpoch = quietAlertPolicyEpoch();
    const observationOwnership = beginObservationOwnership();
    const authority = { policyEpoch, id: observationOwnership } as const;
    const observation = await collectSessionObservation(notificationFingerprints, policyEpoch, observationOwnership);
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

export function startSessionNotificationObserver(): void {
  if (sessionNotificationObservationTimer) return;
  scheduleSessionNotificationObservation();
  sessionNotificationObservationTimer = setInterval(
    scheduleSessionNotificationObservation,
    SESSION_NOTIFICATION_OBSERVATION_INTERVAL_MS,
  );
}

export function stopSessionNotificationObserver(): void {
  if (!sessionNotificationObservationTimer) return;
  clearInterval(sessionNotificationObservationTimer);
  sessionNotificationObservationTimer = null;
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
  forgetQuietAlertRecipientSnapshots([sessionId, sessionName]);
}

export function resetNotificationObservation(): void {
  notificationFingerprints.clear();
}

export function __resetSessionObservationForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionObservationForTests is test-only");
  activityHistory.clear();
  quietAlertHistory.clear();
  activityContinuityTokens.clear();
  dashboardFingerprints.clear();
  notificationFingerprints.clear();
  dashboardObservationPromise = null;
  dashboardObservationCache = null;
  renderedFingerprintFlights.clear();
  knownSessionSummaries.clear();
  nextObservationOwnership = 0;
  latestAuthoritativeObservation = 0;
}

export async function __runSessionNotificationObservationForTests(): Promise<readonly ObservedSessionSummary[]> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__runSessionNotificationObservationForTests is test-only");
  return runSessionNotificationObservation();
}
