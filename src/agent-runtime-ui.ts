import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
  AGENT_SEMANTIC_STATUS_STATE_SET,
  isAgentStatusState,
} from "./agent-status-contract.js";
import type {
  AgentStatusAuthority,
  AgentStatusFreshness,
  AgentStatusSourceKind,
  AgentStatusState,
} from "./agent-status-contract.js";
import type { TriageStatus } from "./triage.js";

export interface SessionRuntimeUiInput {
  readonly runtimeState?: {
    readonly state?: AgentStatusState | string;
    readonly authority?: AgentStatusAuthority | string;
    readonly freshness?: AgentStatusFreshness | string;
    readonly source?: AgentStatusSourceKind | string;
    readonly stale?: boolean;
  };
  readonly triage?: TriageStatus | string;
}

export interface SessionRuntimeUi {
  readonly dot: string;
  readonly card: string;
  readonly label: string;
  readonly title: string;
  readonly badge: string;
}

const RUNTIME_UI: Record<AgentStatusState, SessionRuntimeUi> = {
  [AGENT_STATUS_STATE.RUNNING]: { dot: "green", card: "active-session", label: "running", title: "running", badge: "running" },
  [AGENT_STATUS_STATE.WORKING]: { dot: "green", card: "active-session", label: "working", title: "working", badge: "working" },
  [AGENT_STATUS_STATE.AUDIT]: { dot: "green", card: "active-session", label: "audit", title: "audit", badge: "audit" },
  [AGENT_STATUS_STATE.CLEANUP]: { dot: "green", card: "active-session", label: "cleanup", title: "cleanup", badge: "cleanup" },
  [AGENT_STATUS_STATE.NEEDS_INPUT]: { dot: "yellow", card: "needs-input-session", label: "needs input", title: "needs input", badge: "needs-input" },
  [AGENT_STATUS_STATE.DONE]: { dot: "gray", card: "idle-session", label: "done", title: "done", badge: "done" },
  [AGENT_STATUS_STATE.FAILED]: { dot: "red", card: "failed-session", label: "failed", title: "failed", badge: "failed" },
  [AGENT_STATUS_STATE.STOPPED]: { dot: "gray", card: "idle-session", label: "stopped", title: "stopped", badge: "stopped" },
  [AGENT_STATUS_STATE.OUTPUT]: { dot: "green", card: "active-session", label: "output", title: "recent output", badge: "output" },
  [AGENT_STATUS_STATE.OFF]: { dot: "gray", card: "idle-session", label: "off", title: "broker reports session stopped", badge: "off" },
  [AGENT_STATUS_STATE.IDLE]: { dot: "gray", card: "idle-session", label: "quiet", title: "no output observed in the latest sample", badge: "idle" },
  [AGENT_STATUS_STATE.UNKNOWN]: { dot: "gray", card: "idle-session", label: "unavailable", title: "broker availability unknown", badge: "unknown" },
};

export function sessionRuntimeState(input: SessionRuntimeUiInput): AgentStatusState {
  const runtime = input.runtimeState;
  const state = runtime?.state;
  if (runtime && typeof state === "string" && isAgentStatusState(state)) {
    const fresh = runtime.freshness === AGENT_STATUS_FRESHNESS.FRESH && runtime.stale === false;
    if (
      runtime.source === AGENT_STATUS_SOURCE.LOCAL_MANIFEST
      && runtime.authority === AGENT_STATUS_AUTHORITY.MANIFEST
      && fresh
      && AGENT_SEMANTIC_STATUS_STATE_SET.has(state)
    ) return state;
    if (
      runtime.source === AGENT_STATUS_SOURCE.SCREEN_FALLBACK
      && runtime.authority === AGENT_STATUS_AUTHORITY.FALLBACK
      && fresh
      && (state === AGENT_STATUS_STATE.OUTPUT || state === AGENT_STATUS_STATE.IDLE)
    ) return state;
    if (
      runtime.source === AGENT_STATUS_SOURCE.BROKER_LIVENESS
      && runtime.authority === AGENT_STATUS_AUTHORITY.BROKER
      && (state === AGENT_STATUS_STATE.OFF || state === AGENT_STATUS_STATE.UNKNOWN)
    ) return state;
  }
  return input.triage === "running" ? AGENT_STATUS_STATE.OUTPUT : AGENT_STATUS_STATE.IDLE;
}

export function sessionRuntimeUi(input: SessionRuntimeUiInput): SessionRuntimeUi {
  return RUNTIME_UI[sessionRuntimeState(input)];
}
