import { describe, expect, test } from "bun:test";
import { TERMINAL_LAYOUT_PREFERENCE_KEY, TerminalLayoutRegistry, nearestPaneInDirection } from "../../public/terminal-layout-registry.ts";
import { equalGridLayout, leadStackLayout } from "../../src/extensions/layout-contract.ts";
import {
  DEFAULT_WORKSPACE_SHELL_PREFERENCES,
  normalizeWorkspaceShellPreferences,
  workspaceContextIsVisible,
} from "../../public/workspace-shell.ts";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const entries = new Map(Object.entries(initial));
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } };
}

describe("phase-1 host workspace layout", () => {
  test("keeps equal grid as the explicit built-in default and persists only a user selection", () => {
    const storage = memoryStorage();
    const registry = new TerminalLayoutRegistry(storage);
    expect(registry.selectedId).toBe("equal-grid");
    registry.select("lead-stack");
    expect(new TerminalLayoutRegistry(storage).selectedId).toBe("lead-stack");
  });

  test("restores only an existing saved extension recipe and falls back when it is removed", () => {
    const storage = memoryStorage({ [TERMINAL_LAYOUT_PREFERENCE_KEY]: "notes/recipe" });
    const registry = new TerminalLayoutRegistry(storage);
    expect(registry.selectedId).toBe("equal-grid");
    const unregister = registry.register({ id: "notes/recipe", title: "Recipe", arrange: equalGridLayout });
    expect(registry.selectedId).toBe("notes/recipe");
    unregister();
    expect(registry.selectedId).toBe("equal-grid");
    expect(storage.getItem(TERMINAL_LAYOUT_PREFERENCE_KEY)).toBe("equal-grid");

    const freshStorage = memoryStorage();
    const fresh = new TerminalLayoutRegistry(freshStorage);
    fresh.register({ id: "notes/recipe", title: "Recipe", arrange: equalGridLayout });
    expect(fresh.selectedId).toBe("equal-grid");
    expect(freshStorage.getItem(TERMINAL_LAYOUT_PREFERENCE_KEY)).toBeNull();

    const missingStorage = memoryStorage({ [TERMINAL_LAYOUT_PREFERENCE_KEY]: "missing/recipe" });
    const missing = new TerminalLayoutRegistry(missingStorage);
    expect(missing.finalizeRestoration()).toBe(true);
    expect(missing.selectedId).toBe("equal-grid");
    expect(missingStorage.getItem(TERMINAL_LAYOUT_PREFERENCE_KEY)).toBe("equal-grid");
  });

  test("uses a vertical recovery layout on narrow viewports without changing the chosen desktop recipe", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    registry.select("lead-stack");
    const panes = ["one", "two", "three"];
    const desktop = registry.arrange(panes, "two", { width: 1200, height: 700 });
    const mobile = registry.arrange(panes, "two", { width: 390, height: 700 });
    expect(desktop.placements[0]).toMatchObject({ paneId: "one", rowSpan: 2 });
    expect(mobile.columns).toHaveLength(1);
    expect(mobile.placements.map(placement => placement.row)).toEqual([0, 1, 2]);
    expect(registry.selectedId).toBe("lead-stack");
  });

  test("routes keyboard movement by validated visual geometry without changing pane order", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    registry.select("lead-stack");
    const layout = registry.arrange(["one", "two", "three"], "two", { width: 1200, height: 700 });
    expect(nearestPaneInDirection(layout, "one", "right")).toBe("three"); // equidistant ties use the stable pane ID
    expect(nearestPaneInDirection(layout, "two", "down")).toBe("one");
    expect(nearestPaneInDirection(layout, "one", "left")).toBeNull();
  });

  test("built-in lead stays first across machine focus and refits; custom recipes still receive actual focus", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    const panes = ["local|lead", "https://peer.example|stack", "local|other"];
    registry.select("lead-stack");
    const initial = registry.arrange(panes, panes[0]!, { width: 1200, height: 700 });
    for (const focused of panes) {
      const refit = registry.arrange(panes, focused, { width: 1100, height: 650 });
      expect(refit.placements).toEqual(initial.placements);
      expect(refit.placements[0]?.paneId).toBe(panes[0]);
    }
    registry.register({ id: "custom/focus", title: "Follow focus", arrange: leadStackLayout });
    registry.select("custom/focus");
    expect(registry.arrange(panes, panes[1]!, { width: 1200, height: 700 }).placements[0]?.paneId).toBe(panes[1]);
  });

  test("contains throwing extension layout recipes and recovers with equal-grid geometry", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    registry.register({ id: "notes/broken", title: "Broken", arrange: () => { throw new Error("package failure"); } });
    registry.select("notes/broken");
    const layout = registry.arrange(["one", "two", "three"], "two", { width: 1200, height: 700 });
    expect(layout.placements.map(placement => placement.paneId).sort()).toEqual(["one", "three", "two"]);
    expect(layout.rows).toHaveLength(2);
    expect(registry.selectedId).toBe("notes/broken");
  });

  test("retires saved placement controls without losing size or recovery state", () => {
    expect(normalizeWorkspaceShellPreferences({ placement: "right", splitSize: 410, contextCollapsed: true })).toEqual({ splitSize: 410, contextCollapsed: true, fullView: "none" });
  });

  test("bounds and repairs browser-local shell preferences while retaining recovery state", () => {
    expect(normalizeWorkspaceShellPreferences({ placement: "bottom", splitSize: 9999, contextCollapsed: true, fullView: "context" })).toEqual({
      splitSize: 560, contextCollapsed: true, fullView: "context",
    });
    expect(normalizeWorkspaceShellPreferences({ placement: "bad", splitSize: Number.NaN, fullView: "bad" })).toEqual(DEFAULT_WORKSPACE_SHELL_PREFERENCES);
  });

  test("reports actual context-region visibility for collapse and both full-view modes", () => {
    expect(workspaceContextIsVisible(DEFAULT_WORKSPACE_SHELL_PREFERENCES)).toBe(true);
    expect(workspaceContextIsVisible({ ...DEFAULT_WORKSPACE_SHELL_PREFERENCES, contextCollapsed: true })).toBe(false);
    expect(workspaceContextIsVisible({ ...DEFAULT_WORKSPACE_SHELL_PREFERENCES, fullView: "terminals" })).toBe(false);
    expect(workspaceContextIsVisible({ ...DEFAULT_WORKSPACE_SHELL_PREFERENCES, contextCollapsed: true, fullView: "context" })).toBe(true);
  });
});
