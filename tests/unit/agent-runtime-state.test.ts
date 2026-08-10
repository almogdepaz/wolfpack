import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
  AGENT_STATUS_STATES,
} from "../../src/agent-status-contract.ts";
import {
  AgentRuntimeStateStore,
  deriveAgentRuntimeState,
} from "../../src/server/agent-status.ts";
import { sessionRuntimeUi } from "../../src/agent-runtime-ui.ts";
import type { AgentStatusSource } from "../../src/server/agent-status.ts";

const OBSERVED_AT = "2026-07-25T00:00:00.000Z";

function source(overrides: Partial<AgentStatusSource> = {}): AgentStatusSource {
  return {
    state: AGENT_STATUS_STATE.NEEDS_INPUT,
    authority: AGENT_STATUS_AUTHORITY.MANIFEST,
    freshness: AGENT_STATUS_FRESHNESS.FRESH,
    source: AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
    label: "structured manifest",
    stale: false,
    observedAt: OBSERVED_AT,
    capabilities: ["semantic-state"],
    runId: "run-1",
    runOrder: 1,
    signalSequence: 1,
    ...overrides,
  };
}

describe("agent runtime state reducer", () => {
  test("broker-authoritative liveness overrides structured semantic signals", () => {
    const state = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "dead", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.RUNNING })],
      fallback: { rawOutputChanged: true, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(state.state).toBe(AGENT_STATUS_STATE.OFF);
    expect(state.authority).toBe(AGENT_STATUS_AUTHORITY.BROKER);
    expect(state.source).toBe(AGENT_STATUS_SOURCE.BROKER_LIVENESS);
  });

  test("broker unavailable resolves unknown without treating fallback as evidence", () => {
    const state = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "unavailable", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.DONE })],
      fallback: { rawOutputChanged: true, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(state.state).toBe(AGENT_STATUS_STATE.UNKNOWN);
    expect(state.authority).toBe(AGENT_STATUS_AUTHORITY.BROKER);
  });

  test("unsupported fallback only reports output while bytes are changing", () => {
    const output = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: { rawOutputChanged: true, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const idle = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
      previous: output,
    });

    expect(output.state).toBe(AGENT_STATUS_STATE.OUTPUT);
    expect(idle.state).toBe(AGENT_STATUS_STATE.IDLE);
  });

  test("terminal prose does not create needs-input or done state", () => {
    const state = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: {
        rawOutputChanged: false,
        observedAt: OBSERVED_AT,
        preview: "DONE. need input? approve? failed?",
      },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(state.state).toBe(AGENT_STATUS_STATE.IDLE);
    expect(state.state).not.toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(state.state).not.toBe(AGENT_STATUS_STATE.DONE);
    expect(state.state).not.toBe(AGENT_STATUS_STATE.FAILED);
  });

  test("structured semantic state requires declared capability and freshness", () => {
    const noCapability = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ capabilities: [] })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const stale = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ freshness: AGENT_STATUS_FRESHNESS.STALE, stale: true })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const semantic = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source()],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(noCapability.state).toBe(AGENT_STATUS_STATE.IDLE);
    expect(stale.state).toBe(AGENT_STATUS_STATE.IDLE);
    expect(semantic.state).toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
  });

  test("structured semantic signals without current-run identity cannot claim current state", () => {
    const state = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ runId: undefined, runOrder: undefined, state: AGENT_STATUS_STATE.DONE })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(state.state).toBe(AGENT_STATUS_STATE.IDLE);
  });

  test("late old-run signals cannot overwrite the current run", () => {
    const previous = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.RUNNING, runId: "run-2", runOrder: 2 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-2", runOrder: 2 },
    });
    const next = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, runId: "run-1", runOrder: 1 })],
      fallback: { rawOutputChanged: true, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-2", runOrder: 2 },
      previous,
    });

    expect(next.state).toBe(AGENT_STATUS_STATE.OUTPUT);
    expect(next.runId).toBe("run-2");
  });

  test("runOrder-only newer run accepts reset signal sequence and invalidates acknowledgement", () => {
    const first = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, runId: undefined, runOrder: 1, signalSequence: 5 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runOrder: 1 },
    });
    const acknowledged = { ...first, acknowledgedSequence: first.transitionSequence, acknowledgedAt: "2026-07-25T00:01:00.000Z", unseen: false };
    const next = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, runId: undefined, runOrder: 2, signalSequence: 1, observedAt: "2026-07-25T00:02:00.000Z" })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runOrder: 2 },
      previous: acknowledged,
    });

    expect(next.state).toBe(AGENT_STATUS_STATE.DONE);
    expect(next.runOrder).toBe(2);
    expect(next.signalSequence).toBe(1);
    expect(next.transitionSequence).toBe(first.transitionSequence + 1);
    expect(next.acknowledgedSequence).toBe(first.transitionSequence);
    expect(next.unseen).toBe(true);
  });

  test("runOrder-only older run cannot overwrite newer accepted state", () => {
    const accepted = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, runId: undefined, runOrder: 2, signalSequence: 1 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runOrder: 2 },
    });
    const older = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, runId: undefined, runOrder: 1, signalSequence: 9, observedAt: "2026-07-25T00:02:00.000Z" })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runOrder: 2 },
      previous: accepted,
    });

    expect(older.state).not.toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(older.signalSequence).not.toBe(9);
    expect(older.runOrder).toBe(2);
  });

  test("runOrder-only equal run applies signal sequence monotonicity", () => {
    const accepted = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, runId: undefined, runOrder: 2, signalSequence: 5 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runOrder: 2 },
    });
    const equal = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, runId: undefined, runOrder: 2, signalSequence: 5, observedAt: "2026-07-25T00:02:00.000Z" })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runOrder: 2 },
      previous: accepted,
    });

    expect(equal.state).toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(equal.signalSequence).toBe(5);
    expect(equal.transitionSequence).toBe(accepted.transitionSequence);
  });

  test("higher same-state structured signal sequence invalidates acknowledgement", () => {
    const first = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, signalSequence: 1 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const acknowledged = { ...first, acknowledgedSequence: first.transitionSequence, acknowledgedAt: "2026-07-25T00:01:00.000Z", unseen: false };
    const next = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, signalSequence: 2, observedAt: "2026-07-25T00:02:00.000Z" })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runId: "run-1", runOrder: 1 },
      previous: acknowledged,
    });

    expect(next.state).toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(next.signalSequence).toBe(2);
    expect(next.transitionSequence).toBe(first.transitionSequence + 1);
    expect(next.acknowledgedSequence).toBe(first.transitionSequence);
    expect(next.unseen).toBe(true);
  });

  test("older structured signal sequence cannot overwrite accepted same-run state", () => {
    const accepted = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT, signalSequence: 5 })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const acknowledged = { ...accepted, acknowledgedSequence: accepted.transitionSequence, acknowledgedAt: "2026-07-25T00:01:00.000Z", unseen: false };
    const older = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, signalSequence: 4, observedAt: "2026-07-25T00:02:00.000Z" })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runId: "run-1", runOrder: 1 },
      previous: acknowledged,
    });

    expect(older.state).toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(older.signalSequence).toBe(5);
    expect(older.transitionSequence).toBe(accepted.transitionSequence);
    expect(older.unseen).toBe(false);
  });

  test("transition sequence increments only for effective state transitions", () => {
    const first = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    const same = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
      previous: first,
    });
    const changed = deriveAgentRuntimeState({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [],
      fallback: { rawOutputChanged: true, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
      previous: same,
    });

    expect(first.transitionSequence).toBe(1);
    expect(same.transitionSequence).toBe(1);
    expect(changed.transitionSequence).toBe(2);
    expect(changed.changedAt).toBe(OBSERVED_AT);
  });
});

describe("agent runtime state persistence and acknowledgement", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-runtime-state-"));
    path = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acknowledgement survives restart and newer transition becomes unseen", () => {
    const store = new AgentRuntimeStateStore(path);
    const first = store.reduce({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: OBSERVED_AT },
      sources: [source({ state: AGENT_STATUS_STATE.NEEDS_INPUT })],
      fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
      currentRun: { runId: "run-1", runOrder: 1 },
    });
    expect(first.unseen).toBe(true);

    const acked = store.acknowledge("s1", first.transitionSequence, "2026-07-25T00:01:00.000Z");
    expect(acked?.unseen).toBe(false);

    const restarted = new AgentRuntimeStateStore(path);
    expect(restarted.get("s1")?.acknowledgedSequence).toBe(first.transitionSequence);
    expect(restarted.get("s1")?.unseen).toBe(false);

    const next = restarted.reduce({
      sessionKey: "s1",
      broker: { state: "alive", observedAt: "2026-07-25T00:02:00.000Z" },
      sources: [source({ state: AGENT_STATUS_STATE.DONE, observedAt: "2026-07-25T00:02:00.000Z", signalSequence: 2 })],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:02:00.000Z" },
      currentRun: { runId: "run-1", runOrder: 1 },
    });

    expect(next.transitionSequence).toBe(first.transitionSequence + 1);
    expect(next.unseen).toBe(true);
    expect(next.acknowledgedSequence).toBe(first.transitionSequence);
  });

  test("migrates absent persistence file to empty schema v1 store", () => {
    const store = new AgentRuntimeStateStore(path);
    expect(store.snapshot()).toEqual({ schemaVersion: 1, sessions: {} });
  });

  test("batches observation reductions into one explicit persistence flush", () => {
    const store = new AgentRuntimeStateStore(path);
    for (const sessionKey of ["s1", "s2"]) {
      store.reduce({
        sessionKey,
        broker: { state: "alive", observedAt: OBSERVED_AT },
        sources: [],
        fallback: { rawOutputChanged: false, observedAt: OBSERVED_AT },
        currentRun: { runId: sessionKey, runOrder: 1 },
      }, { persist: false });
    }
    store.prune(new Set(["s1", "s2"]), { persist: false });
    expect(existsSync(path)).toBe(false);

    store.flush();

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(new AgentRuntimeStateStore(path).snapshot().sessions).sort()).toEqual(["s1", "s2"]);
  });
});

describe("agent runtime state ui", () => {
  test("requires valid provenance before showing a semantic state", () => {
    for (const state of AGENT_STATUS_STATES) {
      expect(sessionRuntimeUi({ runtimeState: { state }, triage: "idle" }).label).toBe("quiet");
    }
    expect(sessionRuntimeUi({
      runtimeState: {
        state: AGENT_STATUS_STATE.NEEDS_INPUT,
        authority: AGENT_STATUS_AUTHORITY.MANIFEST,
        freshness: AGENT_STATUS_FRESHNESS.FRESH,
        source: AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
        stale: false,
      },
      triage: "idle",
    }).label).toBe("needs input");
  });

  test("describes observed fallback activity without claiming process state", () => {
    expect(sessionRuntimeUi({
      runtimeState: {
        state: AGENT_STATUS_STATE.OUTPUT,
        authority: AGENT_STATUS_AUTHORITY.FALLBACK,
        freshness: AGENT_STATUS_FRESHNESS.FRESH,
        source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
        stale: false,
      },
      triage: "idle",
    }).label).toBe("output");
    expect(sessionRuntimeUi({
      runtimeState: {
        state: AGENT_STATUS_STATE.IDLE,
        authority: AGENT_STATUS_AUTHORITY.FALLBACK,
        freshness: AGENT_STATUS_FRESHNESS.FRESH,
        source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
        stale: false,
      },
      triage: "running",
    }).label).toBe("quiet");
    expect(sessionRuntimeUi({ triage: "running" }).label).toBe("output");
    expect(sessionRuntimeUi({ triage: "idle" }).label).toBe("quiet");
  });

  test("rejects a state that is inconsistent with its claimed source", () => {
    expect(sessionRuntimeUi({
      runtimeState: {
        state: AGENT_STATUS_STATE.DONE,
        authority: AGENT_STATUS_AUTHORITY.FALLBACK,
        freshness: AGENT_STATUS_FRESHNESS.FRESH,
        source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
        stale: false,
      },
      triage: "idle",
    }).label).toBe("quiet");
  });

  test("uses broker-backed availability labels", () => {
    expect(sessionRuntimeUi({
      runtimeState: {
        state: AGENT_STATUS_STATE.UNKNOWN,
        authority: AGENT_STATUS_AUTHORITY.BROKER,
        freshness: AGENT_STATUS_FRESHNESS.UNKNOWN,
        source: AGENT_STATUS_SOURCE.BROKER_LIVENESS,
        stale: false,
      },
      triage: "idle",
    }).label).toBe("unavailable");
  });
});
