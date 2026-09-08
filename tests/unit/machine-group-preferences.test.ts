import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MACHINE_GROUP_PREFERENCES,
  loadMachineGroupPreferences,
  moveMachineRelative,
  orderMachineGroups,
  reconcileMachineOrder,
  saveMachineGroupPreferences,
  setMachineGroupCollapsed,
} from "../../public/machine-group-preferences.ts";

const local = "local";
const peer = "n-peer:2af8af29-c4fe-44f9-8a99-2a0e35952d74";
const replacement = "n-peer:50d5f3a2-70ef-4b3c-97ce-0aeff91ca851";
const otherPeer = "n-other:ea8838c7-6721-465e-af64-6378be6a9501";

const storage = (value: string | null = null) => {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key: string, next: string) => { stored = next; },
    read: () => stored,
  };
};

describe("machine group preferences", () => {
  test("defaults safely and persists independent surface collapse with shared order", () => {
    const browserStorage = storage();
    const mainCollapsed = setMachineGroupCollapsed(DEFAULT_MACHINE_GROUP_PREFERENCES, "main", peer, true);
    const preferences = setMachineGroupCollapsed({ ...mainCollapsed, order: [local, peer] }, "sidebar", peer, false);

    expect(preferences.collapsed.main).toEqual([peer]);
    expect(preferences.collapsed.sidebar).toEqual([]);
    expect(saveMachineGroupPreferences(browserStorage, preferences)).toBe(true);
    expect(loadMachineGroupPreferences(browserStorage)).toEqual(preferences);
    expect(loadMachineGroupPreferences(null)).toEqual(DEFAULT_MACHINE_GROUP_PREFERENCES);
  });

  test("ignores malformed and duplicate identities without accepting names or origins", () => {
    const browserStorage = storage(JSON.stringify({
      version: 1,
      order: [local, peer, peer, "verified peer", "https://peer.example.ts.net"],
      collapsed: { main: [peer, peer, "bad"], sidebar: [local, "bad"] },
    }));

    expect(loadMachineGroupPreferences(browserStorage)).toEqual({
      order: [local, peer],
      collapsed: { main: [peer], sidebar: [local] },
    });
    expect(loadMachineGroupPreferences(storage("not json"))).toEqual(DEFAULT_MACHINE_GROUP_PREFERENCES);
    expect(saveMachineGroupPreferences({ setItem: () => { throw new Error("full"); } }, DEFAULT_MACHINE_GROUP_PREFERENCES)).toBe(false);
  });

  test("keeps absent identities, appends new and replacement peers, and leaves source order untouched", () => {
    const stored = [local, peer];
    const visible = [local, replacement, otherPeer];
    const reconciled = reconcileMachineOrder(stored, visible);

    expect(reconciled).toEqual([local, peer, replacement, otherPeer]);
    expect(stored).toEqual([local, peer]);
    expect(orderMachineGroups([
      { identity: otherPeer, label: "other" },
      { identity: local, label: "local" },
      { identity: replacement, label: "replacement" },
    ], reconciled, group => group.identity).map(group => group.label)).toEqual(["local", "replacement", "other"]);
  });

  test("moves local and remote groups without mutating the input or accepting invalid targets", () => {
    const order = [local, peer, otherPeer];

    expect(moveMachineRelative(order, local, otherPeer, "after")).toEqual([peer, otherPeer, local]);
    expect(moveMachineRelative(order, peer, local, "before")).toEqual([peer, local, otherPeer]);
    expect(moveMachineRelative(order, peer, replacement, "before")).toEqual(order);
    expect(order).toEqual([local, peer, otherPeer]);
  });
});
