import { describe, expect, test } from "bun:test";
import { normalizeWidgetLayout, WidgetLayout, WIDGET_LAYOUT_KEY } from "../../public/widget-layout.ts";

function memory(initial?: unknown) {
  let value = initial === undefined ? null : JSON.stringify(initial);
  return { getItem: (key: string) => key === WIDGET_LAYOUT_KEY ? value : null, setItem: (_key: string, next: string) => { value = next; } };
}

describe("independent widget placement preferences", () => {
  test("inherits Step3 placement without turning a multi-view catalog into auto-selection", () => {
    const layout = new WidgetLayout(memory(), "bottom");
    expect(layout.area("notes/one")).toBe("bottom");
    expect(layout.selection("bottom", ["notes/one", "notes/two"])).toBeNull();
    expect(layout.selection("bottom", ["notes/one"])).toBe("notes/one");
    expect(layout.selection("right", ["notes/one"])).toBeNull();
  });
  test("moves individual views and restores one selected tab per area", () => {
    const storage = memory();
    const layout = new WidgetLayout(storage);
    layout.select("notes/one");
    layout.move("notes/two", "bottom");
    const restored = new WidgetLayout(storage);
    const available = ["notes/one", "notes/two", "notes/three"];
    expect(restored.selection("right", available)).toBe("notes/one");
    expect(restored.selection("bottom", available)).toBe("notes/two");
    restored.move("notes/one", "bottom");
    expect(restored.selection("bottom", available)).toBe("notes/one");
    expect(restored.selection("right", available)).toBe("notes/three");
    expect(restored.area("notes/two")).toBe("bottom");
  });
  test("saved unknown, disabled or relocated selections cannot invent available contributions", () => {
    const layout = new WidgetLayout(memory({ placements: { "notes/one": "bottom" }, selected: { right: "notes/one", bottom: "missing/view" } }));
    expect(layout.selection("right", ["notes/two", "notes/three"])).toBeNull();
    expect(layout.selection("bottom", [])).toBeNull();
    expect(layout.selection("bottom", ["notes/one"])).toBe("notes/one");
  });
  test("validates identities, areas and preference bounds without accepting prototype placement", () => {
    expect(normalizeWidgetLayout({ placements: { "notes/one": "left", "bad/id/extra": "right", "notes/two": "bottom", "../path": "right" }, selected: { right: "bad id", bottom: "notes/two" }, placement: "left" })).toEqual({ placements: { "notes/two": "bottom" }, selected: { bottom: "notes/two" } });
    expect(normalizeWidgetLayout([])).toEqual({ placements: {}, selected: {} });
    const storage = memory({ placements: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`notes/view-${i}`, "bottom"])) });
    const layout = new WidgetLayout(storage);
    expect(Object.keys(layout.preferences.placements)).toHaveLength(128);
    layout.move("new/view", "bottom");
    expect(Object.keys(layout.preferences.placements)).toHaveLength(128);
    expect(new WidgetLayout(storage).area("new/view")).toBe("bottom");
  });
  test("reports storage failures while retaining a usable in-memory layout, then recovers", () => {
    let fail = true;
    const storage = { getItem: () => { throw Error("blocked"); }, setItem: () => { if (fail) throw Error("blocked"); } };
    const layout = new WidgetLayout(storage);
    layout.move("notes/one", "bottom");
    expect(layout.area("notes/one")).toBe("bottom");
    expect(layout.diagnostic).toContain("this tab only");
    fail = false;
    layout.select("notes/one");
    expect(layout.diagnostic).toBe("");
  });
  test("reset clears placements/selections and inherited bottom default without touching other storage", () => {
    const storage = memory();
    const layout = new WidgetLayout(storage, "bottom");
    layout.move("notes/one", "bottom");
    layout.reset();
    expect(layout.preferences).toEqual({ placements: {}, selected: {} });
    expect(layout.area("notes/one")).toBe("right");
    expect(new WidgetLayout(storage).area("notes/one")).toBe("right");
  });
});
