import { SESSION_ATTENTION, sessionRuntimeUi } from "../src/agent-runtime-ui";
import { AGENT_STATUS_FRESHNESS, AGENT_STATUS_SOURCE } from "../src/agent-status-contract";
import type { SessionRuntimeUiInput } from "../src/agent-runtime-ui";

export interface SessionAttentionCounts {
  readonly needsInput: number;
  readonly failed: number;
  readonly updated: number;
}

export function sessionAttentionCounts(sessions: readonly SessionRuntimeUiInput[]): SessionAttentionCounts {
  let needsInput = 0;
  let failed = 0;
  let updated = 0;
  for (const session of sessions) {
    switch (sessionRuntimeUi(session).attention) {
      case SESSION_ATTENTION.NEEDS_INPUT: needsInput++; break;
      case SESSION_ATTENTION.FAILED: failed++; break;
      case SESSION_ATTENTION.UPDATED: updated++; break;
    }
  }
  return { needsInput, failed, updated };
}

export function sessionAttentionSummary(counts: SessionAttentionCounts): string {
  return `${counts.needsInput} need input, ${counts.failed} failed, ${counts.updated} updated since review`;
}

function statusTimestamp(value: string | undefined): string {
  if (typeof value !== "string") return "unavailable";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "unavailable";
}

const SOURCE_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [AGENT_STATUS_SOURCE.LOCAL_MANIFEST, "local manifest (agent-reported, not verification)"],
  [AGENT_STATUS_SOURCE.SCREEN_FALLBACK, "screen fallback (observed output, not agent intent)"],
  [AGENT_STATUS_SOURCE.BROKER_LIVENESS, "broker liveness (process availability)"],
  [AGENT_STATUS_SOURCE.SESSION_IDENTITY, "session identity (not an activity signal)"],
]);

/** Snapshot disclosure, not a live monitor or an acknowledgement. */
export function sessionStatusDetails(session: SessionRuntimeUiInput): string {
  const runtime = session.runtimeState;
  const source = runtime?.source;
  return [
    `Runtime: ${sessionRuntimeUi(session).label}`,
    `Reported state: ${runtime?.state ?? "unavailable"}`,
    `Reason: ${runtime?.message || "No reason supplied"}`,
    `Source: ${typeof source === "string" ? SOURCE_DESCRIPTIONS.get(source) ?? "unavailable" : "unavailable"}`,
    `Authority: ${runtime?.authority ?? "unavailable"}`,
    `Freshness: ${runtime?.stale === true ? AGENT_STATUS_FRESHNESS.STALE : runtime?.freshness ?? AGENT_STATUS_FRESHNESS.UNKNOWN}`,
    `Observed: ${statusTimestamp(runtime?.observedAt)}`,
    `Changed: ${statusTimestamp(runtime?.changedAt)}`,
    "This status does not establish task success or passing checks.",
  ].join("\n");
}
