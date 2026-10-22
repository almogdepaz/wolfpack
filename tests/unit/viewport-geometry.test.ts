import { describe, expect, test } from "bun:test";
import { keyboardOcclusionHeight, keyboardViewportLayout } from "../../public/viewport-geometry";
import * as geometry from "../../public/viewport-geometry";

describe("native virtual keyboard geometry", () => {
  const frame = { parentTop: 52, fixedHeight: 596 };
  test("native CSS top 437 uses the actual fixed frame, not vv height 340.98", () => {
    expect(geometry.virtualKeyboardViewportLayout).toBeFunction();
    expect(geometry.virtualKeyboardViewportLayout(frame, { top: 437, width: 384, height: 159 }, 0))
      .toEqual({ open: true, inset: 159, top: 52 });
    expect(keyboardViewportLayout(596, frame, { height: 340.98, offsetTop: 0 }).inset).toBe(255);
  });
  test("zero and invalid rectangles are closed, not a vv fallback", () => {
    expect(geometry.virtualKeyboardViewportLayout).toBeFunction();
    for (const rect of [
      { top: 0, width: 0, height: 0 }, { top: 437, width: 0, height: 159 },
      { top: NaN, width: 384, height: 159 }, { top: 437, width: 384, height: Infinity },
      { top: 596, width: 384, height: 159 },
    ]) expect(geometry.virtualKeyboardViewportLayout(frame, rect, 0)).toEqual({ open: false, inset: 0, top: 52 });
  });
  test("maps fractional native CSS coordinates without rounding or body-bottom feedback", () => {
    expect(geometry.virtualKeyboardViewportLayout).toBeFunction();
    expect(geometry.virtualKeyboardViewportLayout({ parentTop: 52, fixedHeight: 915 }, { top: 520.5, width: 412, height: 394.5 }, 0))
      .toEqual({ open: true, inset: 394.5, top: 52 });
  });
  test("panned exposure keeps the first row in the visible frame", () => {
    expect(geometry.virtualKeyboardViewportLayout).toBeFunction();
    expect(geometry.virtualKeyboardViewportLayout({ parentTop: -248, fixedHeight: 844 }, { top: 800, width: 390, height: 44 }, 300))
      .toEqual({ open: true, inset: 44, top: 300 });
  });
  test("clamps a covering rectangle and never inverts the content frame", () => {
    expect(geometry.virtualKeyboardViewportLayout).toBeFunction();
    expect(geometry.virtualKeyboardViewportLayout(frame, { top: -20, width: 384, height: 616 }, 0))
      .toEqual({ open: true, inset: 596, top: 0 });
  });
});

describe("visual viewport keyboard geometry", () => {
  for (const [fixedHeight, inset] of [[859, 339], [915, 395]] as const) {
    test(`Android fixed frame ${fixedHeight}, same absolute parent ending at 859`, () => {
      expect(keyboardOcclusionHeight(fixedHeight, { height: 520, offsetTop: 0 })).toBe(inset);
      expect(keyboardViewportLayout(915, { parentTop: 52, fixedHeight }, { height: 520, offsetTop: 0 }))
        .toEqual({ open: true, inset, top: 52 });
    });
  }
  for (const context of ["Safari-like tab", "standalone-like"]) {
    for (const offsetTop of [0, 120, 300]) test(`${context} 844/500 pan ${offsetTop}`, () => {
      // Fixed frame stays 844 despite the real document/parent panning;
      // neither its scrolled bottom nor the already-inset view is the frame.
      expect(keyboardOcclusionHeight(844, { height: 500, offsetTop })).toBe(344 - offsetTop);
      expect(keyboardViewportLayout(844, { parentTop: 52 - offsetTop, fixedHeight: 844 }, { height: 500, offsetTop }))
        .toEqual({ open: true, inset: 344 - offsetTop, top: Math.max(52 - offsetTop, offsetTop) });
    });
  }
  test("closed viewport and invalid geometry fail closed", () => {
    expect(keyboardViewportLayout(844, { parentTop: 52, fixedHeight: 844 }, { height: 844, offsetTop: 0 }).open).toBe(false);
    expect(keyboardViewportLayout(844, { parentTop: 52, fixedHeight: 844 }, { height: NaN, offsetTop: 0 }).open).toBe(false);
  });
  test("accounts for viewport panning and clamps invalid exposure", () => {
    expect(keyboardOcclusionHeight(800, { height: 500, offsetTop: 20 })).toBe(280);
    expect(keyboardOcclusionHeight(800, { height: 780, offsetTop: 40 })).toBe(0);
    expect(keyboardOcclusionHeight(800, { height: Number.NaN, offsetTop: 0 })).toBe(0);
  });
});
