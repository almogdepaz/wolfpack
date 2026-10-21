import { describe, expect, test } from "bun:test";
import { keyboardOcclusionHeight, keyboardViewportLayout } from "../../public/viewport-geometry";

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
