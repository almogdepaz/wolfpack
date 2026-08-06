import { describe, expect, test } from "bun:test";
import { keyboardOcclusionHeight } from "../../public/viewport-geometry";

describe("visual viewport keyboard geometry", () => {
  test("accounts for viewport panning and clamps invalid exposure", () => {
    expect(keyboardOcclusionHeight(800, { height: 500, offsetTop: 20 })).toBe(280);
    expect(keyboardOcclusionHeight(800, { height: 780, offsetTop: 40 })).toBe(0);
    expect(keyboardOcclusionHeight(800, { height: Number.NaN, offsetTop: 0 })).toBe(0);
  });
});
