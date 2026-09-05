import { AGENT_STATUS_STATE } from "../agent-status-contract.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import { createLogger, errMsg } from "../log.js";
import { reduceActivityObservation } from "../session-activity.js";
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
  getSubscriptionCount,
} from "./push.js";
import type { PublicSessionIdentity } from "./session-identity.js";

const log = createLogger("session-observation");
const SESSION_NOTIFICATION_OBSERVATION_INTERVAL_MS = 5_000;
const DASHBOARD_OBSERVATION_CACHE_TTL_MS = process.env.WOLFPACK_TEST ? 0 : 500;

interface ActivityFingerprint {
  readonly outputSequence?: string;
  readonly rendered?: string;
}

interface RenderedFingerprintFlight {
  readonly token: object;
  readonly outputSequence?: string;
  readonly observedAt: string;
  readonly promise: Promise<string | undefined>;
  readonly activity: Promise<SessionActivityReduction>;
}

interface RenderedActivitySample {
  readonly rendered: string | undefined;
  readonly activity: Promise<SessionActivityReduction>;
}

const activityHistory = new Map<string, SessionActivityHistory>();
const activityContinuityTokens = new Map<string, object>();
const dashboardFingerprints = new Map<string, ActivityFingerprint>();
const notificationFingerprints = new Map<string, ActivityFingerprint>();
const renderedFingerprintFlights = new Map<string, RenderedFingerprintFlight>();
let sessionNotificationObservationTimer: ReturnType<typeof setInterval> | null = null;
let sessionNotificationObservationPromise: Promise<void> | null = null;
let dashboardObservationPromise: Promise<readonly ObservedSessionSummary[]> | null = null;
let dashboardObservationCache: {
  readonly expiresAt: number;
  readonly sessions: readonly ObservedSessionSummary[];
} | null = null;

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
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

interface SessionObservation {
  readonly sessions: readonly ObservedSessionSummary[];
  readonly unreliableSessionKeys: ReadonlySet<string>;
}

const knownSessionSummaries = new Map<string, KnownSessionSummary>();

const SESSION_PREVIEW_MAX_CHARS = 240;

export function lastTerminalPreviewLine(rendered: string | undefined): string {
  if (!rendered) return "";
  const lines = rendered.split("\n");
  const last = (lines.at(-1) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(last).slice(0, SESSION_PREVIEW_MAX_CHARS).join("");
}

function renderedActivityFingerprint(pane: string): string | undefined {
  const normalized = pane
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
  return normalized.length > 0 ? normalized : undefined;
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

function createRenderedFingerprintFlight(
  backend: SessionBackend,
  sessionKey: string,
  name: string,
  outputSequence: string | undefined,
  token: object,
): RenderedFingerprintFlight {
  const observedAt = new Date().toISOString();
  const promise = backend.capturePane(name, { scrollbackLines: 0 })
    .then(renderedActivityFingerprint)
    .catch(() => undefined);
  let flight: RenderedFingerprintFlight;
  const activity = promise.then((rendered) => {
    if (activityContinuityTokens.get(sessionKey) !== token || rendered === undefined) {
      if (rendered === undefined && renderedFingerprintFlights.get(sessionKey)?.promise === promise) {
        renderedFingerprintFlights.delete(sessionKey);
      }
      if (rendered === undefined && activityContinuityTokens.get(sessionKey) === token) {
        activityContinuityTokens.delete(sessionKey);
      }
      return reduceActivityObservation(undefined, { alive: false, observedAt });
    }
    return reduceSessionActivity(sessionKey, { alive: true, observedAt, rendered });
  });
  flight = { token, outputSequence, observedAt, promise, activity };
  return flight;
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
  const rendered = await flight.promise;
  return {
    rendered: activityContinuityTokens.get(sessionKey) === flight.token ? rendered : undefined,
    activity: flight.activity,
  };
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

function observeUnavailableSessions(): SessionObservation {
  activityHistory.clear();
  activityContinuityTokens.clear();
  dashboardFingerprints.clear();
  notificationFingerprints.clear();
  renderedFingerprintFlights.clear();
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
  return { sessions, unreliableSessionKeys: new Set(summariesBySessionKey.keys()) };
}

async function observeSessionFact(
  backend: SessionBackend,
  fact: SessionListFact,
  fingerprints: Map<string, ActivityFingerprint>,
  store: AgentRuntimeStateStore,
  activeNames: Set<string>,
  activeSessionKeys: Set<string>,
  unreliableSessionKeys: Set<string>,
): Promise<ObservedSessionSummary> {
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
  const observedAt = new Date().toISOString();
  const previousFingerprint = fingerprints.get(sessionKey);
  const shouldSampleRenderedState = brokerState === "alive" && (
    previousFingerprint === undefined
    || outputSequence === undefined
    || previousFingerprint.outputSequence !== outputSequence
  );
  const sample = shouldSampleRenderedState
    ? await renderedActivitySample(backend, sessionKey, name, outputSequence)
    : undefined;
  const currentRendered = sample === undefined ? previousFingerprint?.rendered : sample.rendered;
  const rawOutputChanged = shouldSampleRenderedState
    && currentRendered !== undefined
    && previousFingerprint?.rendered !== undefined
    && currentRendered !== previousFingerprint.rendered;
  if (brokerState !== "alive" || (shouldSampleRenderedState && currentRendered === undefined)) {
    // A liveness or capture gap breaks the observed continuity. The next
    // successful rendered sample is a baseline, not a fabricated transition.
    fingerprints.delete(sessionKey);
    activityContinuityTokens.delete(sessionKey);
    renderedFingerprintFlights.delete(sessionKey);
    if (shouldSampleRenderedState && currentRendered === undefined) unreliableSessionKeys.add(sessionKey);
  } else {
    fingerprints.set(sessionKey, { ...(outputSequence !== undefined && { outputSequence }), rendered: currentRendered });
  }
  const activity = sample
    ? (await sample.activity).activity
    : reduceSessionActivity(sessionKey, {
      alive: brokerState === "alive",
      observedAt,
      rendered: currentRendered,
    }).activity;

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
    activity,
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
): void {
  for (const key of fingerprints.keys()) {
    if (!activeSessionKeys.has(key)) fingerprints.delete(key);
  }
  for (const key of activityHistory.keys()) {
    if (!activeSessionKeys.has(key)) activityHistory.delete(key);
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
}

async function collectSessionObservation(
  fingerprints: Map<string, ActivityFingerprint>,
): Promise<SessionObservation> {
  const backend = getBackend();
  const sessionFacts = await listAvailableSessionFacts(backend);
  if (!sessionFacts) return observeUnavailableSessions();

  const activeNames = new Set<string>();
  const activeSessionKeys = new Set<string>();
  const unreliableSessionKeys = new Set<string>();
  const store = getAgentRuntimeStateStore();
  const sessions = await Promise.all(sessionFacts.map((fact) => observeSessionFact(
    backend,
    fact,
    fingerprints,
    store,
    activeNames,
    activeSessionKeys,
    unreliableSessionKeys,
  )));

  sessions.sort((a, b) => a.name.localeCompare(b.name));
  pruneSessionObservationState(fingerprints, activeSessionKeys, activeNames, store);
  return { sessions, unreliableSessionKeys };
}

export async function observeDashboardSessions(): Promise<readonly ObservedSessionSummary[]> {
  const now = Date.now();
  if (dashboardObservationCache && now < dashboardObservationCache.expiresAt) {
    return dashboardObservationCache.sessions;
  }
  if (dashboardObservationPromise) return dashboardObservationPromise;
  dashboardObservationPromise = collectSessionObservation(dashboardFingerprints)
    .then(({ sessions }) => {
      dashboardObservationCache = {
        expiresAt: Date.now() + DASHBOARD_OBSERVATION_CACHE_TTL_MS,
        sessions,
      };
      return sessions;
    })
    .finally(() => {
      dashboardObservationPromise = null;
    });
  return dashboardObservationPromise;
}

async function runSessionNotificationObservation(): Promise<void> {
  if (getSubscriptionCount() === 0) return;
  if (sessionNotificationObservationPromise) return sessionNotificationObservationPromise;
  sessionNotificationObservationPromise = (async () => {
    const observation = await collectSessionObservation(notificationFingerprints);
    await checkSessionTransitions(observation.sessions.map((session) => {
      const sessionKey = session.identity?.wolfpackSessionId ?? session.name;
      return {
        ...session,
        notificationEligible: !observation.unreliableSessionKeys.has(sessionKey),
      };
    }));
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
  activityContinuityTokens.delete(sessionId);
  activityContinuityTokens.delete(sessionName);
  dashboardFingerprints.delete(sessionId);
  dashboardFingerprints.delete(sessionName);
  notificationFingerprints.delete(sessionId);
  notificationFingerprints.delete(sessionName);
  renderedFingerprintFlights.delete(sessionId);
  renderedFingerprintFlights.delete(sessionName);
}

export function resetNotificationObservation(): void {
  notificationFingerprints.clear();
}

export function __resetSessionObservationForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionObservationForTests is test-only");
  activityHistory.clear();
  activityContinuityTokens.clear();
  dashboardFingerprints.clear();
  notificationFingerprints.clear();
  dashboardObservationPromise = null;
  dashboardObservationCache = null;
  renderedFingerprintFlights.clear();
  knownSessionSummaries.clear();
}

export async function __runSessionNotificationObservationForTests(): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__runSessionNotificationObservationForTests is test-only");
  await runSessionNotificationObservation();
}
