import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

interface DelegationGridState {
  delegationGridSessions: Array<{ readonly session: string; readonly _collapsed?: boolean }>;
  delegationGridFocusIndex: number;
}

interface AppGridModule {
  setDelegationGridMembers(members: ReadonlyArray<{
    readonly session: string;
    readonly machine: string;
    readonly role: "root" | "child";
    readonly statusClass: string;
    readonly statusLabel: string;
    readonly idle: boolean;
  }>): void;
}

interface AppStateModule {
  state: DelegationGridState;
}

let appGrid: AppGridModule;
let appState: AppStateModule;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: {
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      createElement() {
        return { textContent: "", innerHTML: "" };
      },
      getElementById() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    Notification: { permission: "default" },
    navigator: {},
  });

  const appGridUrl = new URL("../../public/app-grid.ts", import.meta.url).href;
  const appStateUrl = new URL("../../public/app-state.ts", import.meta.url).href;
  appGrid = await import(appGridUrl) as AppGridModule;
  appState = await import(appStateUrl) as AppStateModule;
});

beforeEach(() => {
  appState.state.delegationGridSessions = [];
  appState.state.delegationGridFocusIndex = 0;
});

describe("delegation grid collapse defaults", () => {
  test("opens every delegation member when a large parent grid is created", () => {
    appGrid.setDelegationGridMembers([
      { session: "parent", machine: "", role: "root", statusClass: "running", statusLabel: "running", idle: false },
      { session: "child-1", machine: "", role: "child", statusClass: "idle", statusLabel: "idle", idle: true },
      { session: "child-2", machine: "", role: "child", statusClass: "idle", statusLabel: "idle", idle: true },
      { session: "child-3", machine: "", role: "child", statusClass: "idle", statusLabel: "idle", idle: true },
      { session: "child-4", machine: "", role: "child", statusClass: "idle", statusLabel: "idle", idle: true },
      { session: "child-5", machine: "", role: "child", statusClass: "idle", statusLabel: "idle", idle: true },
    ]);

    expect(appState.state.delegationGridSessions.map(session => ({
      session: session.session,
      collapsed: !!session._collapsed,
    }))).toEqual([
      { session: "parent", collapsed: false },
      { session: "child-1", collapsed: false },
      { session: "child-2", collapsed: false },
      { session: "child-3", collapsed: false },
      { session: "child-4", collapsed: false },
      { session: "child-5", collapsed: false },
    ]);
  });
});
