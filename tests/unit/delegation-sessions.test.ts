import { describe, expect, test } from "bun:test";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import {
  delegationChildSummaryText,
  delegationGridMembers,
  delegationRootSession,
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
  test("renders parent trees with stable child order and count-only summaries", () => {
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
    expect(rows[0]?.childSummary).toEqual({ total: 3 });
    expect(delegationChildSummaryText(rows[0]!.childSummary!)).toBe("3 children");
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
    expect(rows[0]?.childSummary).toEqual({ total: 1 });
    expect(rows[2]?.childSummary).toEqual({ total: 1 });
  });

  test("does not expose runtime state in child summaries", () => {
    const rows = projectDelegationSessions([
      session("parent", "parent-id"),
      session("failed", "child-1", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.FAILED }),
      session("stopped", "child-2", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.STOPPED }),
      session("output", "child-3", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.OUTPUT }),
      session("working", "child-4", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.WORKING }),
      session("done-seen", "child-5", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.DONE, unseen: false }),
    ]);

    expect(rows[0]?.childSummary).toEqual({ total: 5 });
    expect(delegationChildSummaryText(rows[0]!.childSummary!)).toBe("5 children");
  });

  test("does not summarize an unproven semantic claim as actionable state", () => {
    const parent = session("parent", "parent-id");
    const child = {
      ...session("child", "child-id", { parentId: "parent-id", parentName: "parent" }),
      triage: "idle",
      runtimeState: { state: AGENT_STATUS_STATE.NEEDS_INPUT, unseen: true },
    };

    const rows = projectDelegationSessions([parent, child]);

    expect(rows[0]?.childSummary).toEqual({ total: 1 });
    expect(delegationChildSummaryText(rows[0]!.childSummary!)).toBe("1 child");
  });

  test("returns a root and recursive descendants in projection order", () => {
    const parent = session("parent", "parent-id", { state: AGENT_STATUS_STATE.RUNNING });
    const idleChild = session("idle-child", "child-idle", {
      parentId: "parent-id",
      parentName: "parent",
      state: AGENT_STATUS_STATE.IDLE,
    });
    const attentionChild = session("attention-child", "child-attention", {
      parentId: "parent-id",
      parentName: "parent",
      state: AGENT_STATUS_STATE.NEEDS_INPUT,
    });
    const grandchild = session("grandchild", "grandchild-id", {
      parentId: "child-attention",
      parentName: "attention-child",
      state: AGENT_STATUS_STATE.WORKING,
    });
    const sessions = [idleChild, grandchild, parent, attentionChild];

    expect(delegationGridMembers(sessions, parent).map(row => row.session.name)).toEqual([
      "parent",
      "attention-child",
      "grandchild",
      "idle-child",
    ]);
    expect(delegationRootSession(sessions, grandchild)).toBe(parent);
  });

  test("derives current membership on each projection and leaves orphans unattached", () => {
    const parent = session("parent", "parent-id");
    const child = session("child", "child-id", { parentId: "parent-id", parentName: "parent" });
    const orphan = session("orphan", "orphan-id", { parentId: "gone-id", parentName: "gone" });

    expect(delegationGridMembers([parent, child], parent).map(row => row.session.name)).toEqual(["parent", "child"]);
    expect(delegationGridMembers([parent], parent).map(row => row.session.name)).toEqual(["parent"]);
    expect(delegationRootSession([parent, orphan], orphan)).toBeNull();
  });
});
