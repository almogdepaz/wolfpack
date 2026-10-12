import { describe, expect, test } from "bun:test";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import {
  PROGRAM_STATUS_LIMITS,
  parseBrokerProgramStatusRecord,
  programStatusAgentState,
} from "../../src/program-status-contract.ts";

const blocked = {
  id: "",
  state: "blocked",
  kind: "permission",
  progress: 40,
  app: "claude",
  title: "Plan",
  message: "Apply?",
  updated_at_ms: 1_700_000_000_000,
};

describe("parseBrokerProgramStatusRecord", () => {
  test("projects a complete broker record into the camelCase contract", () => {
    expect(parseBrokerProgramStatusRecord(blocked)).toEqual({
      id: "",
      state: "blocked",
      kind: "permission",
      progress: 40,
      app: "claude",
      title: "Plan",
      message: "Apply?",
      updatedAtMs: 1_700_000_000_000,
    });
  });

  test("omits absent optional fields", () => {
    expect(parseBrokerProgramStatusRecord({ id: "build/test", state: "done", updated_at_ms: 0 })).toEqual({
      id: "build/test",
      state: "done",
      updatedAtMs: 0,
    });
  });

  test("rejects unknown states, kinds and out-of-range progress", () => {
    expect(parseBrokerProgramStatusRecord({ ...blocked, state: "clear" })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, state: "needs-input" })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, kind: "payment" })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, progress: 101 })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, progress: 1.5 })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, updated_at_ms: -1 })).toBeUndefined();
  });

  test("rejects non-objects and wrongly typed fields", () => {
    expect(parseBrokerProgramStatusRecord(undefined)).toBeUndefined();
    expect(parseBrokerProgramStatusRecord(null)).toBeUndefined();
    expect(parseBrokerProgramStatusRecord([blocked])).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, id: 7 })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, message: 7 })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, updated_at_ms: "1" })).toBeUndefined();
  });

  test("rejects text over the protocol byte bounds", () => {
    const overByOne = (bytes: number) => "é".repeat(Math.floor(bytes / 2)) + "xx";
    expect(parseBrokerProgramStatusRecord({ ...blocked, message: "x".repeat(PROGRAM_STATUS_LIMITS.MESSAGE_BYTES) })).toBeDefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, message: overByOne(PROGRAM_STATUS_LIMITS.MESSAGE_BYTES) })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, title: overByOne(PROGRAM_STATUS_LIMITS.TITLE_BYTES) })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, app: overByOne(PROGRAM_STATUS_LIMITS.APP_BYTES) })).toBeUndefined();
    expect(parseBrokerProgramStatusRecord({ ...blocked, id: overByOne(PROGRAM_STATUS_LIMITS.ID_BYTES) })).toBeUndefined();
  });
});

describe("programStatusAgentState", () => {
  test("maps every program state onto the existing agent status vocabulary", () => {
    expect(programStatusAgentState("blocked")).toBe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(programStatusAgentState("working")).toBe(AGENT_STATUS_STATE.WORKING);
    expect(programStatusAgentState("done")).toBe(AGENT_STATUS_STATE.DONE);
    expect(programStatusAgentState("error")).toBe(AGENT_STATUS_STATE.FAILED);
    expect(programStatusAgentState("idle")).toBe(AGENT_STATUS_STATE.IDLE);
  });
});
