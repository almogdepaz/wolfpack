import { describe, expect, test } from "bun:test";
import { nextMenuSelection } from "../../src/menu-navigation.ts";

describe("menu keyboard navigation", () => {
  test("starts at the first item when moving down without a selection", () => {
    expect(nextMenuSelection({ itemCount: 3, selectedIndex: null, direction: 1 })).toBe(0);
  });

  test("starts at the last item when moving up without a selection", () => {
    expect(nextMenuSelection({ itemCount: 3, selectedIndex: null, direction: -1 })).toBe(2);
  });

  test("clamps movement at list boundaries", () => {
    expect(nextMenuSelection({ itemCount: 3, selectedIndex: 0, direction: -1 })).toBe(0);
    expect(nextMenuSelection({ itemCount: 3, selectedIndex: 2, direction: 1 })).toBe(2);
  });

  test("has no selection when the list is empty", () => {
    expect(nextMenuSelection({ itemCount: 0, selectedIndex: null, direction: 1 })).toBeNull();
  });
});
