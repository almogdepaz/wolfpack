import { describe, expect, test } from "bun:test";
import { equalGridLayout, leadStackLayout, LayoutValidationError, validateTerminalLayout, verticalStackLayout } from "../../src/extensions/layout-contract.ts";

const context = { panes: [{ id: "one" }, { id: "two" }, { id: "three" }], selectedPaneId: "two", viewport: { width: 1200, height: 800 } } as const;

describe("extension terminal layout contract", () => {
  test("ships composition helpers for independently installable grid recipes", () => {
    for (const layout of [equalGridLayout(context), leadStackLayout(context), verticalStackLayout(context)]) {
      expect(validateTerminalLayout(layout, context.panes)).toEqual(layout);
      expect(layout.placements.map((placement) => placement.paneId).sort()).toEqual(["one", "three", "two"]);
    }
    expect(leadStackLayout(context).placements[0]).toMatchObject({ paneId: "two", rowSpan: 2 });
  });
  test("rejects layouts that hide, duplicate, overlap, or escape host panes", () => {
    const base = verticalStackLayout(context);
    for (const layout of [
      { ...base, placements: base.placements.slice(1) },
      { ...base, placements: [...base.placements, { paneId: "one", row: 0, column: 0 }] },
      { ...base, placements: base.placements.map((placement, index) => index === 1 ? { ...placement, row: 0 } : placement) },
      { ...base, placements: [{ paneId: "missing", row: 0, column: 0 }] },
      { ...base, rows: [{ size: Number.NaN }] },
    ]) expect(() => validateTerminalLayout(layout as typeof base, context.panes)).toThrow(LayoutValidationError);
  });
});
