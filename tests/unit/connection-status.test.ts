import { describe, expect, test } from "bun:test";
import {
  RECONNECT_CAUSE,
  backendProbeResultFromBody,
  createReconnectStatusTicker,
  describeReconnect,
  nextReconnectCause,
  reconnectCauseFromClose,
  reconnectCauseFromProbe,
  type ReconnectStatus,
} from "../../src/connection-status";
import { CLOSE_CODE_BROKER_UNAVAILABLE, CLOSE_CODE_SERVICE_RESTART } from "../../src/ws-constants";

const status = (overrides: Partial<ReconnectStatus> = {}): ReconnectStatus => ({
  cause: RECONNECT_CAUSE.UNKNOWN,
  attempt: 3,
  retryAt: 10_000,
  ...overrides,
});

describe("describeReconnect labels", () => {
  test.each([
    [RECONNECT_CAUSE.UNKNOWN, undefined, "reconnecting (attempt 3, retry in 2s)"],
    [RECONNECT_CAUSE.SERVER_RESTARTING, undefined, "server restarting — reconnecting (attempt 3, retry in 2s)"],
    [RECONNECT_CAUSE.UNREACHABLE, undefined, "server unreachable (attempt 3, retry in 2s)"],
    [RECONNECT_CAUSE.UNREACHABLE, "sgt", "sgt unreachable (attempt 3, retry in 2s)"],
    [RECONNECT_CAUSE.BROKER_DOWN, undefined, "terminal broker down (attempt 3, retry in 2s)"],
    [RECONNECT_CAUSE.BROKER_DOWN, "sgt", "terminal broker down on sgt (attempt 3, retry in 2s)"],
  ] as const)("%s (machine %s)", (cause, machineLabel, label) => {
    expect(describeReconnect(status({ cause }), 8_000, machineLabel)).toMatchObject({ state: cause, label });
  });

  test("splits the label into a stable lead and a visual-only countdown", () => {
    expect(describeReconnect(status({ cause: RECONNECT_CAUSE.UNREACHABLE }), 8_000, "sgt")).toEqual({
      state: RECONNECT_CAUSE.UNREACHABLE,
      label: "sgt unreachable (attempt 3, retry in 2s)",
      lead: "sgt unreachable (attempt 3",
      countdown: "retry in 2s",
    });
  });

  test("rounds the countdown up to whole seconds", () => {
    expect(describeReconnect(status(), 9_999).label).toBe("reconnecting (attempt 3, retry in 1s)");
    expect(describeReconnect(status(), 8_001).label).toBe("reconnecting (attempt 3, retry in 2s)");
  });

  test("shows connecting once the retry is due", () => {
    expect(describeReconnect(status(), 10_000).label).toBe("reconnecting (attempt 3, connecting…)");
    expect(describeReconnect(status(), 12_000).label).toBe("reconnecting (attempt 3, connecting…)");
  });
});

describe("reconnect cause evidence", () => {
  test("close codes that name their cause", () => {
    expect(reconnectCauseFromClose(CLOSE_CODE_SERVICE_RESTART)).toBe(RECONNECT_CAUSE.SERVER_RESTARTING);
    expect(reconnectCauseFromClose(CLOSE_CODE_BROKER_UNAVAILABLE)).toBe(RECONNECT_CAUSE.BROKER_DOWN);
    expect(reconnectCauseFromClose(1006)).toBeNull();
    expect(reconnectCauseFromClose(1011)).toBeNull();
  });

  test("backend probe results", () => {
    expect(reconnectCauseFromProbe({ kind: "unreachable" })).toBe(RECONNECT_CAUSE.UNREACHABLE);
    expect(reconnectCauseFromProbe({ kind: "responded", brokerReady: false })).toBe(RECONNECT_CAUSE.BROKER_DOWN);
    expect(reconnectCauseFromProbe({ kind: "responded", brokerReady: true })).toBe(RECONNECT_CAUSE.UNKNOWN);
    // 401/429/etc. carry no readiness field: the server is up, cause unknown.
    expect(reconnectCauseFromProbe({ kind: "responded" })).toBe(RECONNECT_CAUSE.UNKNOWN);
  });

  test("reads broker readiness from any /api/backend body", () => {
    expect(backendProbeResultFromBody({ brokerReady: false, error: "broker unavailable" })).toEqual({ kind: "responded", brokerReady: false });
    expect(backendProbeResultFromBody({ brokerReady: true, counts: { broker: 1 } })).toEqual({ kind: "responded", brokerReady: true });
    expect(backendProbeResultFromBody({ error: "unauthorized" })).toEqual({ kind: "responded" });
    expect(backendProbeResultFromBody(null)).toEqual({ kind: "responded" });
    expect(backendProbeResultFromBody({ brokerReady: "no" })).toEqual({ kind: "responded" });
  });

  test("a restarting server is expected to be unreachable for a while", () => {
    expect(nextReconnectCause(RECONNECT_CAUSE.SERVER_RESTARTING, RECONNECT_CAUSE.UNREACHABLE)).toBe(RECONNECT_CAUSE.SERVER_RESTARTING);
    expect(nextReconnectCause(RECONNECT_CAUSE.SERVER_RESTARTING, RECONNECT_CAUSE.UNKNOWN)).toBe(RECONNECT_CAUSE.SERVER_RESTARTING);
    expect(nextReconnectCause(RECONNECT_CAUSE.SERVER_RESTARTING, RECONNECT_CAUSE.BROKER_DOWN)).toBe(RECONNECT_CAUSE.BROKER_DOWN);
  });

  test("other causes follow the newest evidence", () => {
    expect(nextReconnectCause(RECONNECT_CAUSE.UNKNOWN, RECONNECT_CAUSE.UNREACHABLE)).toBe(RECONNECT_CAUSE.UNREACHABLE);
    expect(nextReconnectCause(RECONNECT_CAUSE.BROKER_DOWN, RECONNECT_CAUSE.UNKNOWN)).toBe(RECONNECT_CAUSE.UNKNOWN);
    expect(nextReconnectCause(RECONNECT_CAUSE.UNREACHABLE, RECONNECT_CAUSE.SERVER_RESTARTING)).toBe(RECONNECT_CAUSE.SERVER_RESTARTING);
  });
});

describe("createReconnectStatusTicker", () => {
  function fakeClock(start: number) {
    let now = start;
    let tick: (() => void) | null = null;
    return {
      runtime: {
        now: () => now,
        setInterval: (callback: () => void) => { tick = callback; return 1; },
        clearInterval: () => { tick = null; },
      },
      advance(ms: number) { now += ms; tick?.(); },
      get running() { return tick !== null; },
    };
  }

  test("renders immediately, re-renders each tick, and stops cleanly", () => {
    const clock = fakeClock(8_000);
    const labels: string[] = [];
    const ticker = createReconnectStatusTicker((view) => labels.push(view.label), clock.runtime);
    ticker.update(status(), undefined);
    clock.advance(1_000);
    clock.advance(1_000);
    expect(labels).toEqual([
      "reconnecting (attempt 3, retry in 2s)",
      "reconnecting (attempt 3, retry in 1s)",
      "reconnecting (attempt 3, connecting…)",
    ]);
    ticker.stop();
    expect(clock.running).toBe(false);
    clock.advance(1_000);
    expect(labels).toHaveLength(3);
  });

  test("an update replaces the status without stacking intervals", () => {
    const clock = fakeClock(8_000);
    const labels: string[] = [];
    const ticker = createReconnectStatusTicker((view) => labels.push(view.label), clock.runtime);
    ticker.update(status(), undefined);
    ticker.update(status({ cause: RECONNECT_CAUSE.UNREACHABLE }), "sgt");
    clock.advance(1_000);
    expect(labels).toEqual([
      "reconnecting (attempt 3, retry in 2s)",
      "sgt unreachable (attempt 3, retry in 2s)",
      "sgt unreachable (attempt 3, retry in 1s)",
    ]);
  });

  test("a render that stops the ticker leaves no interval running", () => {
    const clock = fakeClock(8_000);
    let renders = 0;
    const ticker = createReconnectStatusTicker(() => { renders++; ticker.stop(); }, clock.runtime);
    ticker.update(status(), undefined);
    expect(renders).toBe(1);
    expect(clock.running).toBe(false);
  });
});
