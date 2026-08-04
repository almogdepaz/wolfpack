import { AGENT_STATUS_STATE } from "../agent-status-contract.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import { createLogger, errMsg } from "../log.js";
import type { TriageStatus } from "../triage.js";
import {
  collectAgentStatusSources,
  getAgentRuntimeStateStore,
  type AgentRuntimeState,
} from "./agent-status.js";
import { getBackend, getRouter, type SessionListFact } from "./backend.js";
import {
  checkSessionTransitions,
  getSubscriptionCount,
} from "./push.js";
import type { PublicSessionIdentity } from "./session-identity.js";

const log = createLogger("session-observation");
const SESSION_NOTIFICATION_OBSERVATION_INTERVAL_MS = 5_000;

const dashboardActivityFingerprints = new Map<string, string>();
const notificationActivityFingerprints = new Map<string, string>();
let sessionNotificationObservationTimer: ReturnType<typeof setInterval> | null = null;
let sessionNotificationObservationPromise: Promise<void> | null = null;

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
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

interface SessionObservation {
  readonly sessions: readonly ObservedSessionSummary[];
  readonly unreliableSessionKeys: ReadonlySet<string>;
}

const knownSessionSummaries = new Map<string, KnownSessionSummary>();

function renderedActivityFingerprint(pane: string): string | undefined {
  const normalized = pane
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
  return normalized.length > 0 ? normalized : undefined;
}

async function collectSessionObservation(
  fingerprints: Map<string, string>,
): Promise<SessionObservation> {
  const backend = getBackend();
  const router = getRouter();
  const routerOwnsBackend = backend === router;
  let brokerAvailable = !(routerOwnsBackend && !router.isBrokerAvailable());
  let sessionFacts: SessionListFact[] = [];
  if (brokerAvailable) {
    try {
      sessionFacts = await backend.listSessionFacts();
    } catch {
      brokerAvailable = false;
    }
  }

  if (!brokerAvailable) {
    const observedAt = new Date().toISOString();
    const store = getAgentRuntimeStateStore();
    const summariesBySessionKey = new Map<string, KnownSessionSummary>();
    for (const summary of knownSessionSummaries.values()) {
      summariesBySessionKey.set(summary.identity?.wolfpackSessionId ?? summary.name, summary);
    }
    for (const sessionKey of Object.keys(store.snapshot().sessions)) {
      if (!summariesBySessionKey.has(sessionKey)) summariesBySessionKey.set(sessionKey, { name: sessionKey, lastLine: "" });
    }
    const sessions = Array.from(summariesBySessionKey.entries()).map(([sessionKey, { name, lastLine, identity }]) => {
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
      });
      return { name, lastLine, triage: "idle" as TriageStatus, runtimeState, ...(identity && { identity }) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { sessions, unreliableSessionKeys: new Set(summariesBySessionKey.keys()) };
  }

  const activeNames = new Set<string>();
  const activeSessionKeys = new Set<string>();
  const unreliableSessionKeys = new Set<string>();
  const sessions = await Promise.all(sessionFacts.map(async (fact): Promise<ObservedSessionSummary> => {
    const name = fact.name;
    activeNames.add(name);
    const brokerState = fact.alive ? "alive" : "dead";
    const identity = fact.identity;
    const sessionKey = identity?.wolfpackSessionId ?? name;
    activeSessionKeys.add(sessionKey);

    let activityFingerprint: string | undefined;
    if (brokerState === "alive") {
      try {
        activityFingerprint = renderedActivityFingerprint(await backend.capturePane(name, { scrollbackLines: 0 }));
      } catch {
        activityFingerprint = undefined;
      }
      if (activityFingerprint === undefined) unreliableSessionKeys.add(sessionKey);
    }
    const previousFingerprint = fingerprints.get(sessionKey);
    const rawOutputChanged = activityFingerprint !== undefined
      && previousFingerprint !== undefined
      && activityFingerprint !== previousFingerprint;
    if (activityFingerprint !== undefined) fingerprints.set(sessionKey, activityFingerprint);

    const outputSequence = brokerOutputSequence(fact.outputSequence);
    const triage: TriageStatus = rawOutputChanged ? "running" : "idle";
    const lastLine = "";
    const observedAt = new Date().toISOString();
    const runtimeState = getAgentRuntimeStateStore().reduce({
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
    });
    const summary = {
      name,
      lastLine,
      triage,
      runtimeState,
      ...(outputSequence !== undefined && { outputSequence }),
      ...(identity && { identity }),
    };
    knownSessionSummaries.set(name, { name, lastLine, ...(identity && { identity }) });
    return summary;
  }));

  sessions.sort((a, b) => a.name.localeCompare(b.name));
  for (const key of fingerprints.keys()) {
    if (!activeSessionKeys.has(key)) fingerprints.delete(key);
  }
  for (const key of knownSessionSummaries.keys()) {
    if (!activeNames.has(key)) knownSessionSummaries.delete(key);
  }
  getAgentRuntimeStateStore().prune(activeSessionKeys);
  return { sessions, unreliableSessionKeys };
}

export async function observeDashboardSessions(): Promise<readonly ObservedSessionSummary[]> {
  return (await collectSessionObservation(dashboardActivityFingerprints)).sessions;
}

async function runSessionNotificationObservation(): Promise<void> {
  if (getSubscriptionCount() === 0) return;
  if (sessionNotificationObservationPromise) return sessionNotificationObservationPromise;
  sessionNotificationObservationPromise = (async () => {
    const observation = await collectSessionObservation(notificationActivityFingerprints);
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
  dashboardActivityFingerprints.delete(sessionId);
  dashboardActivityFingerprints.delete(sessionName);
  notificationActivityFingerprints.delete(sessionId);
  notificationActivityFingerprints.delete(sessionName);
}

export function resetNotificationObservation(): void {
  notificationActivityFingerprints.clear();
}

export function __resetSessionObservationForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionObservationForTests is test-only");
  dashboardActivityFingerprints.clear();
  notificationActivityFingerprints.clear();
  knownSessionSummaries.clear();
}

export async function __runSessionNotificationObservationForTests(): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__runSessionNotificationObservationForTests is test-only");
  await runSessionNotificationObservation();
}
