import { describe, expect, test } from "bun:test";
import type { NamedViewRecord } from "../../src/named-views.ts";
const storage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  innerWidth: 1280,
  addEventListener() {},
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
};
(globalThis as unknown as { document: unknown }).document = {
  addEventListener() {},
  createElement: () => ({ textContent: "", innerHTML: "" }),
};
(globalThis as unknown as { localStorage: unknown }).localStorage = (globalThis as unknown as { window: { localStorage: unknown } }).window.localStorage;

const {
  collectNamedViewMembersFromGrid,
  collectUpdatedNamedViewMembersFromGrid,
  renderNamedViewsSection,
  resolveNamedViewMembers,
} = await import("../../public/app-named-views.ts");

const view = (members: NamedViewRecord["members"], focused?: NamedViewRecord["focused"]): NamedViewRecord => ({
  schemaVersion: 1,
  id: "view_1",
  name: "Release",
  members,
  ...(focused ? { focused } : {}),
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
});

describe("browser named-view resolution", () => {
  test("resolves only by stable machineUrl/sessionId and preserves ordered unavailable same-name slots", () => {
    const resolved = resolveNamedViewMembers(
      view([
        { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
        { machineUrl: "", sessionId: "old:another-project", sessionName: "another-project" },
      ], { machineUrl: "", sessionId: "old:another-project" }),
      [
        { machineUrl: "", sessionName: "another-project", sessionId: "mock:another-project" },
        { machineUrl: "", sessionName: "test-project", sessionId: "mock:test-project" },
      ],
    );

    expect(resolved.focusIndex).toBe(1);
    expect(resolved.members.map((member) => ({
      sessionName: member.member.sessionName,
      available: member.available,
      liveSessionName: member.live?.sessionName,
      sessionId: member.member.sessionId,
    }))).toEqual([
      {
        sessionName: "test-project",
        available: true,
        liveSessionName: "test-project",
        sessionId: "mock:test-project",
      },
      {
        sessionName: "another-project",
        available: false,
        liveSessionName: undefined,
        sessionId: "old:another-project",
      },
    ]);
  });

  test("renders no manual refresh control", () => {
    expect(renderNamedViewsSection("desktop")).not.toContain("refreshNamedViews");
    expect(renderNamedViewsSection("desktop")).not.toContain(">↻</button>");
  });

  test("collects active grid members from live identities while preserving unavailable named-view slots", () => {
    const members = collectNamedViewMembersFromGrid(
      [
        { machine: "", session: "test-project" },
        {
          machine: "https://peer.tailnet.ts.net",
          session: "peer-old-name",
          _namedViewSessionId: "peer-stale-id",
          _namedViewLabel: "peer-old-name",
          _namedViewUnavailable: true,
        },
      ],
      [
        { machineUrl: "", sessionName: "test-project", sessionId: "mock:test-project" },
        { machineUrl: "https://peer.tailnet.ts.net", sessionName: "peer-old-name", sessionId: "peer-new-id" },
      ],
    );

    expect(members).toEqual([
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "https://peer.tailnet.ts.net", sessionId: "peer-stale-id", sessionName: "peer-old-name" },
    ]);
  });

  test("explicit update rebinds a missing stable identity to the current same-name session", () => {
    const members = collectUpdatedNamedViewMembersFromGrid(
      [{
        machine: "",
        session: "looper-ai-2-sub-agent",
        _namedViewSessionId: "d2b4e74f-c9f7-4901-873e-64554cbee4ec",
        _namedViewLabel: "looper-ai-2-sub-agent",
        _namedViewUnavailable: true,
      }],
      [{
        machineUrl: "",
        sessionName: "looper-ai-2-sub-agent",
        sessionId: "b3381ef8-e1f5-4cc9-a383-5b03f22b03d8",
      }],
    );

    expect(members).toEqual([{
      machineUrl: "",
      sessionId: "b3381ef8-e1f5-4cc9-a383-5b03f22b03d8",
      sessionName: "looper-ai-2-sub-agent",
    }]);
  });
});
