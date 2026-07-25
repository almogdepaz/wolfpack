import { describe, expect, test } from "bun:test";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import {
  delegationChildSummaryText,
  projectDelegationSessions,
} from "../../public/delegation-sessions.ts";

function session(
  name: string,
  id: string,
  options: {
    readonly parentId?: string;
    readonly parentName?: string;
    readonly state?: string;
    readonly unseen?: boolean;
  } = {},
) {
  return {
    name,
    identity: {
      wolfpackSessionId: id,
      wolfpackSessionName: name,
      parentSession: options.parentId && options.parentName
        ? {
          wolfpackSessionId: options.parentId,
          wolfpackSessionName: options.parentName,
        }
        : undefined,
    },
    runtimeState: options.state
      ? {
        state: options.state,
        unseen: options.unseen,
      }
      : undefined,
  };
}

describe("delegation session projection", () => {
  test("renders parent trees with attention children before stable child order and runtime summaries", () => {
    const rows = projectDelegationSessions([
      session("parent", "parent-id", { state: AGENT_STATUS_STATE.RUNNING }),
      session("z-idle-child", "child-3", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.IDLE }),
      session("a-needs-input", "child-1", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.NEEDS_INPUT }),
      session("b-done-unseen", "child-2", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.DONE, unseen: true }),
      session("solo", "solo-id", { state: AGENT_STATUS_STATE.IDLE }),
    ]);

    expect(rows.map(row => row.session.name)).toEqual([
      "parent",
      "a-needs-input",
      "b-done-unseen",
      "z-idle-child",
      "solo",
    ]);
    expect(rows.map(row => row.role)).toEqual(["root", "child", "child", "child", "root"]);
    expect(rows[0]?.childSummary).toEqual({
      total: 3,
      needsInput: 1,
      failedStopped: 0,
      doneUnseen: 1,
      workingOutput: 0,
      idle: 1,
    });
    expect(delegationChildSummaryText(rows[0]!.childSummary!)).toBe("3 children · 1 needs input · 1 done unseen · 1 idle");
  });

  test("keeps children with missing parents visible as explicit orphans", () => {
    const rows = projectDelegationSessions([
      session("orphan-child", "orphan-id", { parentId: "missing-parent-id", parentName: "missing <parent>", state: AGENT_STATUS_STATE.WORKING }),
      session("solo", "solo-id", { state: AGENT_STATUS_STATE.IDLE }),
    ]);

    expect(rows.map(row => ({ name: row.session.name, role: row.role, parent: row.parent?.wolfpackSessionName }))).toEqual([
      { name: "solo", role: "root", parent: undefined },
      { name: "orphan-child", role: "orphan", parent: "missing <parent>" },
    ]);
    expect(rows[1]?.childSummary).toBeNull();
  });

  test("keeps orphan roots with their own child summaries and recursive children", () => {
    const rows = projectDelegationSessions([
      session("orphan-b", "orphan-b-id", { parentId: "missing-b", parentName: "missing b", state: AGENT_STATUS_STATE.IDLE }),
      session("orphan-b-child", "orphan-b-child-id", { parentId: "orphan-b-id", parentName: "orphan-b", state: AGENT_STATUS_STATE.NEEDS_INPUT }),
      session("orphan-a", "orphan-a-id", { parentId: "missing-a", parentName: "missing a", state: AGENT_STATUS_STATE.IDLE }),
      session("orphan-a-child", "orphan-a-child-id", { parentId: "orphan-a-id", parentName: "orphan-a", state: AGENT_STATUS_STATE.WORKING }),
    ]);

    expect(rows.map(row => ({ name: row.session.name, role: row.role }))).toEqual([
      { name: "orphan-b", role: "orphan" },
      { name: "orphan-b-child", role: "child" },
      { name: "orphan-a", role: "orphan" },
      { name: "orphan-a-child", role: "child" },
    ]);
    expect(rows[0]?.childSummary).toMatchObject({ total: 1, needsInput: 1 });
    expect(rows[2]?.childSummary).toMatchObject({ total: 1, workingOutput: 1 });
  });

  test("summarizes child status from canonical runtime state buckets", () => {
    const rows = projectDelegationSessions([
      session("parent", "parent-id"),
      session("failed", "child-1", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.FAILED }),
      session("stopped", "child-2", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.STOPPED }),
      session("output", "child-3", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.OUTPUT }),
      session("working", "child-4", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.WORKING }),
      session("done-seen", "child-5", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.DONE, unseen: false }),
    ]);

    expect(rows[0]?.childSummary).toEqual({
      total: 5,
      needsInput: 0,
      failedStopped: 2,
      doneUnseen: 0,
      workingOutput: 2,
      idle: 1,
    });
    expect(delegationChildSummaryText(rows[0]!.childSummary!)).toBe("5 children · 2 failed/stopped · 2 working/output · 1 idle");
  });
});
