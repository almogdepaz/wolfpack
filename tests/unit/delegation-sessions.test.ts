import { describe, expect, test } from "bun:test";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import {
  delegationAncestorIds,
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

function trustedSession(name: string, state: string, parentId?: string) {
  return {
    ...session(name, name, { parentId, parentName: parentId }),
    runtimeState: { state, authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false },
  };
}

describe("delegation descendant status", () => {
  test("failure outranks attention, activity and idle across nested descendants, not the parent", () => {
    const parent = trustedSession("parent", "failed");
    const child = trustedSession("child", "done", "parent");
    const active = trustedSession("active", "working", "child");
    const need = trustedSession("need", "needs-input", "child");
    const failed = trustedSession("failed", "failed", "child");
    const summarize = (...descendants: ReturnType<typeof trustedSession>[]) => projectDelegationSessions([parent, child, ...descendants])[0]!.childSummary;
    expect(summarize(active, need, failed)).toEqual({ total: 1, status: "fail" });
    expect(summarize(active, need)).toEqual({ total: 1, status: "need" });
    expect(summarize(active)).toEqual({ total: 1, status: "work" });
    expect(summarize()).toEqual({ total: 1, status: "idle" });
    expect(projectDelegationSessions([parent, child, need])[1]!.childSummary).toEqual({ total: 1, status: "need" });
  });

  test("canonical freshness, authority, fallback output and unknown liveness govern status", () => {
    const parent = trustedSession("parent", "done");
    const child = trustedSession("child", "failed", "parent");
    const status = (runtimeState: typeof child.runtimeState, triage = "idle") => projectDelegationSessions([parent, { ...child, runtimeState, triage }])[0]!.childSummary;
    expect(status({ ...child.runtimeState, stale: true })).toEqual({ total: 1, status: "idle" });
    expect(status({ ...child.runtimeState, authority: "fallback" })).toEqual({ total: 1, status: "idle" });
    expect(status({ ...child.runtimeState, freshness: "stale" }, "running")).toEqual({ total: 1, status: "work" });
    expect(status({ ...child.runtimeState, state: "output", authority: "fallback", source: "screen-fallback" })).toEqual({ total: 1, status: "work" });
    expect(status({ ...child.runtimeState, state: "needs-input", authority: "program", source: "program-status" })).toEqual({ total: 1, status: "need" });
    expect(status({ ...child.runtimeState, state: "unknown", authority: AGENT_STATUS_AUTHORITY.BROKER, source: "broker-liveness" })).toEqual({ total: 1, status: "unavailable" });
  });

  test("unknown is neutral without masking a known actionable descendant", () => {
    const parent = trustedSession("parent", "done");
    const unknown = { ...trustedSession("unknown", "unknown", "parent"), runtimeState: { state: "unknown", authority: AGENT_STATUS_AUTHORITY.BROKER, source: "broker-liveness" } };
    const idle = trustedSession("idle", "done", "parent");
    expect(projectDelegationSessions([parent, unknown, idle])[0]!.childSummary).toEqual({ total: 2, status: "unavailable" });
    expect(projectDelegationSessions([parent, unknown, trustedSession("active", "working", "parent")])[0]!.childSummary).toEqual({ total: 2, status: "work" });
  });

  test("removal and reparenting recompute status; missing UUID parents never link by name", () => {
    const root = trustedSession("root", "done");
    const other = trustedSession("other", "done");
    const child = trustedSession("child", "needs-input", "root");
    expect(projectDelegationSessions([root, child])[0]!.childSummary?.status).toBe("need");
    expect(projectDelegationSessions([root])[0]!.childSummary).toBeNull();
    const moved = trustedSession("child", "needs-input", "other");
    const rows = projectDelegationSessions([root, other, moved]);
    expect(rows[0]!.childSummary).toBeNull();
    expect(rows[1]!.childSummary?.status).toBe("need");
    const orphan = { ...child, identity: { ...child.identity, parentSession: { wolfpackSessionId: "absent", wolfpackSessionName: "root" } } };
    expect(projectDelegationSessions([root, orphan])[0]!.childSummary).toBeNull();
    // Separate machine inventories may reuse names and UUIDs without sharing facts.
    expect(projectDelegationSessions([root, trustedSession("child", "done", "root")])[0]!.childSummary?.status).toBe("idle");
  });

  test("cycles terminate, deduplicate UUIDs and exclude each summary's own session", () => {
    const a = trustedSession("a", "failed", "b");
    const b = trustedSession("b", "working", "a");
    const rows = projectDelegationSessions([a, b, b]);
    expect(rows.map(row => row.session.name)).toEqual(["a", "b"]);
    expect(rows[0]!.childSummary?.status).toBe("work");
    expect(rows[1]!.childSummary?.status).toBe("fail");
    const self = trustedSession("self", "failed", "self");
    expect(projectDelegationSessions([self])[0]!.childSummary?.status).toBe("idle");
  });
});

describe("delegation session projection", () => {
  test("renders parent trees with stable child order and direct-child totals", () => {
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
    expect(rows[0]?.childSummary).toEqual({ total: 3, status: "idle" });
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
    expect(rows[0]?.childSummary).toEqual({ total: 1, status: "idle" });
    expect(rows[2]?.childSummary).toEqual({ total: 1, status: "idle" });
  });

  test("does not trust raw runtime state in child summaries", () => {
    const rows = projectDelegationSessions([
      session("parent", "parent-id"),
      session("failed", "child-1", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.FAILED }),
      session("stopped", "child-2", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.STOPPED }),
      session("output", "child-3", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.OUTPUT }),
      session("working", "child-4", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.WORKING }),
      session("done-seen", "child-5", { parentId: "parent-id", parentName: "parent", state: AGENT_STATUS_STATE.DONE, unseen: false }),
    ]);

    expect(rows[0]?.childSummary).toEqual({ total: 5, status: "idle" });
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

    expect(rows[0]?.childSummary).toEqual({ total: 1, status: "idle" });
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

describe("delegationAncestorIds", () => {
  test("lists the present ancestors nearest first; a root or an orphan has none; a cycle ends", () => {
    const grand = session("grand", "grand-id");
    const parent = session("parent", "parent-id", { parentId: "grand-id", parentName: "grand" });
    const child = session("child", "child-id", { parentId: "parent-id", parentName: "parent" });
    const orphan = session("orphan", "orphan-id", { parentId: "gone-id", parentName: "gone" });
    const sessions = [grand, parent, child, orphan];
    expect(delegationAncestorIds(sessions, child)).toEqual(["parent-id", "grand-id"]);
    expect(delegationAncestorIds(sessions, parent)).toEqual(["grand-id"]);
    expect(delegationAncestorIds(sessions, grand)).toEqual([]);
    expect(delegationAncestorIds(sessions, orphan)).toEqual([]);
    const a = session("a", "a-id", { parentId: "b-id", parentName: "b" });
    const b = session("b", "b-id", { parentId: "a-id", parentName: "a" });
    expect(delegationAncestorIds([a, b], a)).toEqual(["b-id"]);
  });
});
