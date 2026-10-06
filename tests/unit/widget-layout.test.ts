import { describe, expect, test } from "bun:test";
import { normalizeWidgetLayout, WidgetLayout, WIDGET_LAYOUT_KEY } from "../../public/widget-layout.ts";

function memory(initial?: unknown) {
  let value = initial === undefined ? null : JSON.stringify(initial);
  return { getItem: (key: string) => key === WIDGET_LAYOUT_KEY ? value : null, setItem: (_key: string, next: string) => { value = next; } };
}

describe("independent widget placement preferences", () => {
  test("individual collapsed and closed views persist without hiding their package siblings", () => {
    const storage = memory(), layout = new WidgetLayout(storage);
    layout.setWidgetState("notes/one", "collapsed");
    layout.setWidgetState("notes/two", "closed");
    expect(new WidgetLayout(storage).widgetState("notes/one")).toBe("collapsed");
    expect(new WidgetLayout(storage).widgetState("notes/two")).toBe("closed");
    expect(layout.widgetState("notes/three")).toBe("open");
    layout.setWidgetState("notes/one", "open");
    expect(layout.widgetState("notes/two")).toBe("closed");
    layout.reopenWidgets();
    expect(layout.preferences).toEqual({ placements: {}, selected: {} });
  });
  test("workspace close persists across sessions without rewriting individual layout and reopen clears it", () => {
    const storage = memory(), layout = new WidgetLayout(storage);
    layout.move("notes/one", "bottom"); layout.setWidgetState("notes/one", "collapsed");
    layout.setWidgetState("notes/two", "closed");
    const before = layout.preferences;
    layout.closeWidgets();
    const restored = new WidgetLayout(storage);
    expect(restored.widgetsClosed).toBe(true);
    expect(restored.preferences).toEqual({ ...before, widgetsClosed: true });
    expect(restored.widgetState(":terminals")).toBe("open");
    restored.reopenWidgets();
    expect(new WidgetLayout(storage).widgetsClosed).toBe(false);
    expect(restored.widgetState("notes/one")).toBe("collapsed");
    expect(restored.widgetState("notes/two")).toBe("open");
    expect(restored.preferences.placements).toEqual(before.placements);
    expect(restored.preferences.selected).toEqual(before.selected);
    restored.closeWidgets(); restored.reset();
    expect(new WidgetLayout(storage).preferences).toEqual({ placements: {}, selected: {} });
  });
  test("workspace close accepts only a boolean and retains tab-local state on storage failure", () => {
    for (const widgetsClosed of [false, "true", 1, [], {}]) expect(normalizeWidgetLayout({ widgetsClosed })).toEqual({ placements: {}, selected: {} });
    expect(normalizeWidgetLayout({ widgetsClosed: true })).toEqual({ placements: {}, selected: {}, widgetsClosed: true });
    const layout = new WidgetLayout({ getItem: () => null, setItem: () => { throw Error("blocked"); } });
    layout.closeWidgets(); expect(layout.widgetsClosed).toBe(true); expect(layout.diagnostic).toContain("this tab only");
    layout.reopenWidgets(); expect(layout.widgetsClosed).toBe(false);
  });
  test("widget state is bounded presentation data, never native-panel visibility", () => {
    const layout = new WidgetLayout(memory({ widgets: { ":terminals": "closed", "bad/id/extra": "collapsed", "notes/one": "unknown", "notes/two": "closed" } }));
    expect(layout.preferences.widgets).toEqual({ "notes/two": "closed" });
    layout.setWidgetState(":sessions", "closed");
    expect(layout.widgetState(":sessions")).toBe("open");
    for (let i = 0; i < 150; i++) layout.setWidgetState(`notes/view-${i}`, "collapsed");
    expect(Object.keys(layout.preferences.widgets!)).toHaveLength(128);
    expect(layout.widgetState("notes/view-149")).toBe("collapsed");
  });
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
    expect(normalizeWidgetLayout({ placements: { "notes/one": "floating", "bad/id/extra": "right", "notes/two": "bottom", "../path": "right" }, selected: { right: "bad id", bottom: "notes/two" }, placement: "left" })).toEqual({ placements: { "notes/two": "bottom" }, selected: { bottom: "notes/two" } });
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
