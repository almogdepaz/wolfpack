/**
 * Reconnect status policy for terminal views: which cause a disconnect has
 * and how the banner / grid cell describes it. Pure; renderers only display.
 */
import { CLOSE_CODE_BROKER_UNAVAILABLE, CLOSE_CODE_SERVICE_RESTART } from "./ws-constants.js";

export const RECONNECT_CAUSE = {
  UNKNOWN: "reconnecting",
  SERVER_RESTARTING: "server-restarting",
  UNREACHABLE: "unreachable",
  BROKER_DOWN: "broker-down",
} as const;

export type ReconnectCause = typeof RECONNECT_CAUSE[keyof typeof RECONNECT_CAUSE];

export interface ReconnectStatus {
  readonly cause: ReconnectCause;
  /** 1-based attempt number of the pending retry. */
  readonly attempt: number;
  /** Epoch ms at which the pending retry fires. */
  readonly retryAt: number;
}

/** Result of probing `GET /api/backend` after a disconnect. */
export type BackendProbeResult =
  | { readonly kind: "unreachable" }
  | { readonly kind: "responded"; readonly brokerReady?: boolean };

export interface ReconnectView {
  readonly state: ReconnectCause;
  /** Full visible text: `${lead}, ${countdown})`. */
  readonly label: string;
  /** Cause and attempt; stable between ticks, so safe to announce. */
  readonly lead: string;
  /** "retry in Ns" or "connecting…"; changes every tick, visual only. */
  readonly countdown: string;
}

/** Probe deadline; a server that cannot answer in this window counts as unreachable. */
export const BACKEND_PROBE_TIMEOUT_MS = 3_000;

/** Any HTTP answer means the server is reachable; `brokerReady` is read when present. */
export function backendProbeResultFromBody(body: unknown): BackendProbeResult {
  const brokerReady = body && typeof body === "object" ? (body as { brokerReady?: unknown }).brokerReady : undefined;
  return typeof brokerReady === "boolean" ? { kind: "responded", brokerReady } : { kind: "responded" };
}

/** Close codes that carry their own cause; null means probe the server. */
export function reconnectCauseFromClose(code: number): ReconnectCause | null {
  if (code === CLOSE_CODE_SERVICE_RESTART) return RECONNECT_CAUSE.SERVER_RESTARTING;
  if (code === CLOSE_CODE_BROKER_UNAVAILABLE) return RECONNECT_CAUSE.BROKER_DOWN;
  return null;
}

export function reconnectCauseFromProbe(result: BackendProbeResult): ReconnectCause {
  if (result.kind === "unreachable") return RECONNECT_CAUSE.UNREACHABLE;
  return result.brokerReady === false ? RECONNECT_CAUSE.BROKER_DOWN : RECONNECT_CAUSE.UNKNOWN;
}

/**
 * Fold new evidence into the current cause. A restarting server is expected
 * to be unreachable (or answer without readiness) until it is back, so only
 * a broker-down answer replaces it.
 */
export function nextReconnectCause(current: ReconnectCause, evidence: ReconnectCause): ReconnectCause {
  if (current === RECONNECT_CAUSE.SERVER_RESTARTING && evidence !== RECONNECT_CAUSE.BROKER_DOWN) return current;
  return evidence;
}

function reconnectHeadline(cause: ReconnectCause, machineLabel: string | undefined): string {
  switch (cause) {
    case RECONNECT_CAUSE.SERVER_RESTARTING:
      return "server restarting — reconnecting";
    case RECONNECT_CAUSE.UNREACHABLE:
      return `${machineLabel ?? "server"} unreachable`;
    case RECONNECT_CAUSE.BROKER_DOWN:
      return `terminal broker down${machineLabel ? ` on ${machineLabel}` : ""}`;
    case RECONNECT_CAUSE.UNKNOWN:
      return "reconnecting";
  }
}

/** `machineLabel` names a remote machine; omit it for the local server. */
export function describeReconnect(status: ReconnectStatus, now: number, machineLabel?: string): ReconnectView {
  const remainingMs = status.retryAt - now;
  const countdown = remainingMs > 0 ? `retry in ${Math.ceil(remainingMs / 1000)}s` : "connecting…";
  const lead = `${reconnectHeadline(status.cause, machineLabel)} (attempt ${status.attempt}`;
  return { state: status.cause, label: `${lead}, ${countdown})`, lead, countdown };
}

export interface ReconnectStatusTickerRuntime {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTickerRuntime: ReconnectStatusTickerRuntime = {
  now: Date.now,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ReconnectStatusTicker {
  update(status: ReconnectStatus, machineLabel: string | undefined): void;
  stop(): void;
}

/** Re-renders the countdown once per second until stopped. */
export function createReconnectStatusTicker(
  render: (view: ReconnectView) => void,
  runtime: ReconnectStatusTickerRuntime = browserTickerRuntime,
): ReconnectStatusTicker {
  let handle: unknown = null;
  let current: { status: ReconnectStatus; machineLabel: string | undefined } | null = null;
  const draw = (): void => {
    if (current) render(describeReconnect(current.status, runtime.now(), current.machineLabel));
  };
  return {
    update(status, machineLabel) {
      current = { status, machineLabel };
      draw();
      // The render may have stopped the ticker (its target went away).
      if (current && handle === null) handle = runtime.setInterval(draw, 1000);
    },
    stop() {
      current = null;
      if (handle !== null) {
        runtime.clearInterval(handle);
        handle = null;
      }
    },
  };
}
