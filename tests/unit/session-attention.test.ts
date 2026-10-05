import { describe, expect, test } from "bun:test";
import { sessionRuntimeUi } from "../../src/agent-runtime-ui.ts";
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
} from "../../src/agent-status-contract.ts";
import type { SessionRuntimeUiInput } from "../../src/agent-runtime-ui.ts";

function manifest(state: string, overrides: Record<string, unknown> = {}): SessionRuntimeUiInput {
  return {
    runtimeState: {
      state,
      authority: AGENT_STATUS_AUTHORITY.MANIFEST,
      source: AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
      freshness: AGENT_STATUS_FRESHNESS.FRESH,
      stale: false,
      ...overrides,
    },
  };
}

describe("session attention projection", () => {
  test.each([
    [AGENT_STATUS_STATE.NEEDS_INPUT, "needs-input"],
    [AGENT_STATUS_STATE.FAILED, "failed"],
  ])("%s requires action even after its update has been reviewed", (state, attention) => {
    expect(sessionRuntimeUi(manifest(state, { unseen: false }))).toMatchObject({ attention });
  });

  test.each([
    { freshness: "stale", stale: true },
    { freshness: "missing" },
    { freshness: "malformed" },
    { freshness: "unknown" },
    { authority: "fallback", source: "screen-fallback" },
    { authority: "identity", source: "session-identity" },
  ])("untrusted input/failure status does not create urgency: %j", (override) => {
    for (const state of [AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_STATE.FAILED]) {
      expect(sessionRuntimeUi(manifest(state, override))).toMatchObject({ attention: "none" });
    }
  });

  test.each(["working", "done", "idle", "stopped", "unknown"])("unseen %s is an update, not a claim of completion", (state) => {
    expect(sessionRuntimeUi(manifest(state, { unseen: true }))).toMatchObject({ attention: "updated" });
    expect(sessionRuntimeUi(manifest(state, { unseen: false }))).toMatchObject({ attention: "none" });
  });

  test("an unseen observation stays a nonurgent update when semantic provenance is absent", () => {
    expect(sessionRuntimeUi({ runtimeState: { state: "needs-input", unseen: true } }))
      .toMatchObject({ attention: "updated", label: "quiet" });
  });

  test("output and silence alone do not imply a human is needed", () => {
    expect(sessionRuntimeUi({ triage: "running" })).toMatchObject({ attention: "none", label: "output" });
    expect(sessionRuntimeUi({ triage: "idle" })).toMatchObject({ attention: "none", label: "quiet" });
    expect(sessionRuntimeUi({})).toMatchObject({ attention: "none" });
  });

  test("broker liveness does not invent semantic failure", () => {
    expect(sessionRuntimeUi({ runtimeState: {
      state: "off", authority: "liveness", source: "broker-liveness", freshness: "fresh", stale: false,
    } })).toMatchObject({ attention: "none", label: "off" });
  });
});
