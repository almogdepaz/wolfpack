import { describe, expect, test } from "bun:test";
import { dockTargetAt } from "../../public/workspace-drag.ts";
import { normalizeWidgetLayout, WidgetLayout } from "../../public/widget-layout.ts";

const sessions = ":sessions", terminals = ":terminals", widget = "agent-context/context";
function memory() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}

describe("built-in workspace docking", () => {
  test("drop hit-testing uses four bounded docks and rejects outside or invalid geometry", () => {
    const box = { left: 100, top: 50, width: 1000, height: 500 };
    expect(dockTargetAt(200, 100, box)).toBe("left");
    expect(dockTargetAt(600, 100, box)).toBe("main");
    expect(dockTargetAt(1000, 500, box)).toBe("right");
    expect(dockTargetAt(600, 500, box)).toBe("bottom");
    expect(dockTargetAt(99, 100, box)).toBeNull();
    expect(dockTargetAt(600, 551, box)).toBeNull();
    expect(dockTargetAt(600, 100, { ...box, width: 0 })).toBeNull();
    expect(dockTargetAt(NaN, 100, box)).toBeNull();
  });
  test("Sessions starts Left, the intact terminal grid Main, widgets Right", () => {
    const layout = new WidgetLayout(memory());
    expect(layout.area(sessions)).toBe("left");
    expect(layout.area(terminals)).toBe("main");
    expect(layout.area(widget)).toBe("right");
  });
  test("moving the last Main panel promotes another available panel atomically", () => {
    const store = memory(), layout = new WidgetLayout(store);
    const available = [sessions, terminals, widget];
    expect(layout.replacement(terminals, "bottom", available)).toBe(sessions);
    expect(layout.move(terminals, "bottom", available)).toBe(true);
    expect(layout.area(terminals)).toBe("bottom");
    expect(layout.area(sessions)).toBe("main");
    expect(layout.area(widget)).toBe("right");
    const restored = new WidgetLayout(store);
    expect(restored.selection("main", available)).toBe(sessions);
    expect(restored.selection("bottom", available)).toBe(terminals);
  });
  test("an occupied destination groups tabs; grid membership is never a placement preference", () => {
    const layout = new WidgetLayout(memory());
    const available = [sessions, terminals, widget];
    layout.move(sessions, "right", available);
    expect(layout.area(sessions)).toBe("right");
    expect(layout.area(widget)).toBe("right");
    expect(layout.area(terminals)).toBe("main");
    expect(layout.selection("right", available)).toBe(sessions);
    layout.select(widget);
    expect(layout.selection("right", available)).toBe(widget);
    expect(Object.keys(layout.preferences.placements)).toEqual([sessions]);
  });
  test("the sole remaining Main panel cannot be moved away", () => {
    const store = memory(), layout = new WidgetLayout(store);
    const before = layout.preferences;
    expect(layout.move(terminals, "bottom", [terminals])).toBe(false);
    expect(layout.preferences).toBe(before);
    expect(store.getItem()).toBeNull();
    expect(layout.diagnostic).toContain("Main");
  });
  test("runtime recovery fills Main without overwriting hidden or unavailable panels' preferences", () => {
    const layout = new WidgetLayout(memory());
    layout.move(terminals, "bottom", [terminals, widget]);
    expect(layout.area(widget)).toBe("main");
    const before = JSON.stringify(layout.preferences);
    expect(layout.areasFor([terminals])[terminals]).toBe("main");
    expect(JSON.stringify(layout.preferences)).toBe(before);
    expect(layout.areasFor([terminals, widget])).toEqual({ [terminals]: "bottom", [widget]: "main" });
  });
  test("preview validation neither mutates preferences nor permits an unavailable or sole Main panel", () => {
    const store = memory(), layout = new WidgetLayout(store);
    const before = layout.preferences;
    expect(layout.canMove(terminals, "bottom", [terminals])).toBe(false);
    expect(layout.canMove(terminals, "bottom", [terminals, ":unknown"])).toBe(false);
    expect(layout.canMove(terminals, "bottom", [terminals, sessions])).toBe(true);
    expect(layout.canMove("unknown/view", "main", [terminals, sessions])).toBe(false);
    expect(layout.preferences).toBe(before);
    expect(layout.diagnostic).toBe("");
    expect(store.getItem()).toBeNull();
  });
  test("host IDs are reserved and unavailable stored contributions cannot fill Main", () => {
    const normalized = normalizeWidgetLayout({ placements: { [terminals]: "left", [sessions]: "bottom", ":unknown": "main", "unknown/view": "main", "bad/path/extra": "left" } });
    expect(normalized.placements).toEqual({ [terminals]: "left", [sessions]: "bottom", "unknown/view": "main" });
    const layout = new WidgetLayout({ getItem: () => JSON.stringify(normalized), setItem: () => {} });
    expect(layout.areasFor([terminals, sessions])[terminals]).toBe("main");
    expect(layout.areasFor([terminals, sessions])).not.toHaveProperty("unknown/view");
  });
});
