export const AGENT_STATUS_STATE = {
  RUNNING: "running",
  WORKING: "working",
  AUDIT: "audit",
  CLEANUP: "cleanup",
  NEEDS_INPUT: "needs-input",
  DONE: "done",
  FAILED: "failed",
  STOPPED: "stopped",
  OUTPUT: "output",
  OFF: "off",
  IDLE: "idle",
  UNKNOWN: "unknown",
} as const;

export const AGENT_STATUS_STATES = [
  AGENT_STATUS_STATE.RUNNING,
  AGENT_STATUS_STATE.WORKING,
  AGENT_STATUS_STATE.AUDIT,
  AGENT_STATUS_STATE.CLEANUP,
  AGENT_STATUS_STATE.NEEDS_INPUT,
  AGENT_STATUS_STATE.DONE,
  AGENT_STATUS_STATE.FAILED,
  AGENT_STATUS_STATE.STOPPED,
  AGENT_STATUS_STATE.OUTPUT,
  AGENT_STATUS_STATE.OFF,
  AGENT_STATUS_STATE.IDLE,
  AGENT_STATUS_STATE.UNKNOWN,
] as const;

export type AgentStatusState = typeof AGENT_STATUS_STATES[number];

export const AGENT_STATUS_AUTHORITY = {
  BROKER: "liveness",
  LIFECYCLE: "lifecycle",
  MANIFEST: "manifest",
  FALLBACK: "fallback",
  IDENTITY: "identity",
} as const;

export const AGENT_STATUS_AUTHORITIES = [
  AGENT_STATUS_AUTHORITY.BROKER,
  AGENT_STATUS_AUTHORITY.LIFECYCLE,
  AGENT_STATUS_AUTHORITY.MANIFEST,
  AGENT_STATUS_AUTHORITY.FALLBACK,
  AGENT_STATUS_AUTHORITY.IDENTITY,
] as const;

export type AgentStatusAuthority = typeof AGENT_STATUS_AUTHORITIES[number];

export const AGENT_STATUS_FRESHNESS = {
  FRESH: "fresh",
  STALE: "stale",
  MISSING: "missing",
  MALFORMED: "malformed",
  UNKNOWN: "unknown",
} as const;

export const AGENT_STATUS_FRESHNESSES = [
  AGENT_STATUS_FRESHNESS.FRESH,
  AGENT_STATUS_FRESHNESS.STALE,
  AGENT_STATUS_FRESHNESS.MISSING,
  AGENT_STATUS_FRESHNESS.MALFORMED,
  AGENT_STATUS_FRESHNESS.UNKNOWN,
] as const;

export type AgentStatusFreshness = typeof AGENT_STATUS_FRESHNESSES[number];

export const AGENT_STATUS_SOURCE = {
  BROKER_LIVENESS: "broker-liveness",
  LOCAL_MANIFEST: "local-manifest",
  SCREEN_FALLBACK: "screen-fallback",
  SESSION_IDENTITY: "session-identity",
} as const;

export const AGENT_STATUS_SOURCES = [
  AGENT_STATUS_SOURCE.BROKER_LIVENESS,
  AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
  AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
  AGENT_STATUS_SOURCE.SESSION_IDENTITY,
] as const;

export type AgentStatusSourceKind = typeof AGENT_STATUS_SOURCES[number];

export const AGENT_STATUS_CAPABILITY = {
  SEMANTIC_STATE: "semantic-state",
} as const;

export const AGENT_STATUS_CAPABILITIES = [
  AGENT_STATUS_CAPABILITY.SEMANTIC_STATE,
] as const;

export type AgentStatusCapability = typeof AGENT_STATUS_CAPABILITIES[number];

const AGENT_STATUS_STATE_SET: ReadonlySet<string> = new Set(AGENT_STATUS_STATES);

export function isAgentStatusState(value: string): value is AgentStatusState {
  return AGENT_STATUS_STATE_SET.has(value);
}

export function agentStatusLabel(state: AgentStatusState): string {
  return state.toUpperCase();
}
