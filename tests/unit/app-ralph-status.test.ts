import { describe, expect, test, beforeAll } from "bun:test";

beforeAll(() => {
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    innerWidth: 1024,
    Notification: { permission: "denied" },
    addEventListener: () => {},
  };
  (globalThis as any).Notification = { permission: "denied" };
  (globalThis as any).PushManager = function PushManager() {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  (globalThis as any).document = {
    createElement: () => {
      const el: any = {};
      Object.defineProperty(el, "textContent", {
        set(value: string) { el.innerHTML = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
      });
      return el;
    },
    body: { classList: { toggle() {}, remove() {}, add() {} } },
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

describe("app ralph authority rendering", () => {
  test("renders source authority and stale state", async () => {
    const { renderRalphCardHtml, getRalphStatus } = await import("../../src/ralph-card-render.ts");
    const loop = {
      project: "wolfpack",
      active: true,
      completed: false,
      tasksDone: 0,
      tasksTotal: 1,
      statusSource: {
        state: "cleanup",
        authority: "manifest",
        freshness: "stale",
        label: "manifest",
        stale: true,
        message: "old status",
      },
    };

    expect(getRalphStatus(loop).status).toBe("cleanup");
    const html = renderRalphCardHtml(loop, "");
    expect(html).toContain("CLEANUP");
    expect(html).toContain("manifest · manifest · stale");
    expect(html).toContain("ralph-authority manifest stale");
  });

  test("renders unknown authority without blocking card actions", async () => {
    const { renderRalphCardHtml, getRalphStatus } = await import("../../src/ralph-card-render.ts");
    const loop = {
      project: "wolfpack",
      active: false,
      completed: false,
      tasksDone: 0,
      tasksTotal: 0,
      statusSource: {
        state: "unknown",
        authority: "identity",
        freshness: "unknown",
        label: "identity only",
        stale: false,
      },
    };

    expect(getRalphStatus(loop).status).toBe("unknown");
    const html = renderRalphCardHtml(loop, "");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("openRalphDetail");
    expect(html).toContain("identity · identity only · unknown");
  });
});
