import { describe, expect, test } from "bun:test";
import { nextAttachDimensionAction } from "../../src/attach-dimensions";

describe("attach dimension retry decision", () => {
  test("sends attach when dimensions are available", () => {
    expect(nextAttachDimensionAction({ cols: 80, rows: 24 }, 0, 5)).toEqual({ kind: "send" });
  });

  test("retries while dimensions are unavailable and attempts remain", () => {
    expect(nextAttachDimensionAction(null, 2, 5)).toEqual({ kind: "retry", nextAttempt: 3 });
  });

  test("fails after the retry budget is exhausted", () => {
    expect(nextAttachDimensionAction(null, 5, 5)).toEqual({ kind: "fail" });
  });
});
