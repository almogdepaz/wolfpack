import { describe, expect, test } from "bun:test";
import { TerminalLayoutRegistry, nearestPaneInDirection } from "../../public/terminal-layout-registry.ts";
import {
  DEFAULT_WORKSPACE_SHELL_PREFERENCES,
  normalizeWorkspaceShellPreferences,
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

  test("uses a vertical recovery layout on narrow viewports without changing the chosen desktop recipe", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    registry.select("lead-stack");
    const panes = ["one", "two", "three"];
    const desktop = registry.arrange(panes, "two", { width: 1200, height: 700 });
    const mobile = registry.arrange(panes, "two", { width: 390, height: 700 });
    expect(desktop.placements[0]).toMatchObject({ paneId: "two", rowSpan: 2 });
    expect(mobile.columns).toHaveLength(1);
    expect(mobile.placements.map(placement => placement.row)).toEqual([0, 1, 2]);
    expect(registry.selectedId).toBe("lead-stack");
  });

  test("routes keyboard movement by validated visual geometry without changing pane order", () => {
    const registry = new TerminalLayoutRegistry(memoryStorage());
    registry.select("lead-stack");
    const layout = registry.arrange(["one", "two", "three"], "two", { width: 1200, height: 700 });
    expect(nearestPaneInDirection(layout, "two", "right")).toBe("one");
    expect(nearestPaneInDirection(layout, "one", "down")).toBe("two");
    expect(nearestPaneInDirection(layout, "two", "left")).toBeNull();
  });

  test("bounds and repairs browser-local shell preferences while retaining recovery state", () => {
    expect(normalizeWorkspaceShellPreferences({ placement: "bottom", splitSize: 9999, contextCollapsed: true, fullView: "context" })).toEqual({
      placement: "bottom", splitSize: 560, contextCollapsed: true, fullView: "context",
    });
    expect(normalizeWorkspaceShellPreferences({ placement: "bad", splitSize: Number.NaN, fullView: "bad" })).toEqual(DEFAULT_WORKSPACE_SHELL_PREFERENCES);
  });
});
