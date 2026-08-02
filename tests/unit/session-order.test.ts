import { describe, expect, test } from "bun:test";
import { projectDelegationSessions } from "../../public/delegation-sessions.ts";
import {
  loadSessionOrder,
  moveSessionRelative,
  orderDelegationSessionRows,
  reconcileSessionOrder,
  resetMachineSessionOrder,
  saveSessionOrder,
  type SessionOrderIdentity,
} from "../../public/session-order.ts";

const local = (sessionId: string): SessionOrderIdentity => ({ machineUrl: "", sessionId });
const remote = (sessionId: string): SessionOrderIdentity => ({ machineUrl: "https://remote", sessionId });

function session(name: string, id: string, parent?: { readonly id: string; readonly name: string }) {
  return {
    name,
    identity: {
      wolfpackSessionId: id,
      wolfpackSessionName: name,
      ...(parent && {
        parentSession: {
          wolfpackSessionId: parent.id,
          wolfpackSessionName: parent.name,
        },
      }),
    },
  };
}

describe("persistent session order", () => {
  test("loads only valid unique stable identities and tolerates unavailable storage", () => {
    const storage = {
      getItem: () => JSON.stringify({
        version: 1,
        sessions: [
          local("one"),
          { machineUrl: "", sessionId: 4 },
          local("one"),
          remote("two"),
        ],
      }),
    };

    expect(loadSessionOrder(storage)).toEqual([local("one"), remote("two")]);
    expect(loadSessionOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(loadSessionOrder({ getItem: () => "not json" })).toEqual([]);
    expect(loadSessionOrder(null)).toEqual([]);
  });

  test("reconciles stale identities away and appends new sessions without persisting", () => {
    const stored = [local("gone"), local("two"), remote("remote-one")];
    const visible = [local("one"), local("two"), local("three")];

    expect(reconcileSessionOrder(stored, visible)).toEqual([
      local("two"),
      local("one"),
      local("three"),
    ]);
  });

  test("moves a session relative to another session in an explicit sibling scope", () => {
    const order = [local("root"), local("first"), local("second"), local("other-root")];
    const siblings = [local("first"), local("second")];

    expect(moveSessionRelative(order, siblings, local("second"), local("first"), "before")).toEqual([
      local("root"),
      local("second"),
      local("first"),
      local("other-root"),
    ]);
    expect(moveSessionRelative(order, siblings, local("root"), local("first"), "before")).toEqual(order);
  });

  test("orders roots as whole trees and children only among siblings", () => {
    const parent = { id: "parent-id", name: "parent" };
    const rows = projectDelegationSessions([
      session("parent", parent.id),
      session("a-child", "a-child-id", parent),
      session("b-child", "b-child-id", parent),
      session("solo", "solo-id"),
    ]);
    const order = [
      local("solo-id"),
      local("b-child-id"),
      local("parent-id"),
      local("a-child-id"),
    ];

    expect(orderDelegationSessionRows(rows, order, "").map(row => row.session.name)).toEqual([
      "solo",
      "parent",
      "b-child",
      "a-child",
    ]);
  });

  test("stable identities preserve order when names and runtime states change", () => {
    const originalRows = projectDelegationSessions([
      session("first", "first-id"),
      session("second", "second-id"),
    ]);
    const refreshedRows = projectDelegationSessions([
      { ...session("second-renamed", "second-id"), runtimeState: { state: "needs-input" } },
      { ...session("first-renamed", "first-id"), runtimeState: { state: "done" } },
    ]);
    const order = [local("second-id"), local("first-id")];

    expect(orderDelegationSessionRows(originalRows, order, "").map(row => row.session.name)).toEqual(["second", "first"]);
    expect(orderDelegationSessionRows(refreshedRows, order, "").map(row => row.session.name)).toEqual(["second-renamed", "first-renamed"]);
  });

  test("resets one machine without changing another and reports storage write failures", () => {
    const order = [local("one"), remote("two"), local("three")];
    const writes: string[] = [];

    expect(resetMachineSessionOrder(order, "")).toEqual([remote("two")]);
    expect(saveSessionOrder({ setItem: (_key, value) => { writes.push(value); } }, order)).toBe(true);
    expect(JSON.parse(writes[0]!)).toEqual({ version: 1, sessions: order });
    expect(saveSessionOrder({ setItem: () => { throw new Error("full"); } }, order)).toBe(false);
    expect(saveSessionOrder(null, order)).toBe(false);
  });
});
