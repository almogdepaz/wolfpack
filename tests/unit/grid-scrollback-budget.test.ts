import { describe, expect, test } from "bun:test";
import { gridTerminalScrollbackBudget } from "../../src/grid-scrollback-policy";

describe("adaptive grid scrollback", () => {
  test("shrinks as cells increase and on constrained devices", () => {
    expect(gridTerminalScrollbackBudget(1, 8)).toBe(1000);
    expect(gridTerminalScrollbackBudget(4, 8)).toBe(500);
    expect(gridTerminalScrollbackBudget(4, 2)).toBe(250);
    expect(gridTerminalScrollbackBudget(100, 2)).toBe(200);
  });
});
