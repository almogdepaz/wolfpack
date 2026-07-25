import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { AgentStatusState } from "./agent-status-contract.js";
import type { TriageStatus } from "./triage.js";

export interface SessionRuntimeUiInput {
  readonly runtimeState?: {
    readonly state?: AgentStatusState;
    readonly unseen?: boolean;
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
  [AGENT_STATUS_STATE.OFF]: { dot: "gray", card: "idle-session", label: "off", title: "off", badge: "off" },
  [AGENT_STATUS_STATE.IDLE]: { dot: "gray", card: "idle-session", label: "idle", title: "idle", badge: "idle" },
  [AGENT_STATUS_STATE.UNKNOWN]: { dot: "gray", card: "idle-session", label: "unknown", title: "unknown", badge: "unknown" },
};

export function sessionRuntimeUi(input: SessionRuntimeUiInput): SessionRuntimeUi {
  const state = input.runtimeState?.state;
  if (state && state in RUNTIME_UI) return RUNTIME_UI[state];
  return input.triage === "running"
    ? RUNTIME_UI[AGENT_STATUS_STATE.RUNNING]
    : RUNTIME_UI[AGENT_STATUS_STATE.IDLE];
}
