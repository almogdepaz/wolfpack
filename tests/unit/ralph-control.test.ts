import { describe, expect, test } from "bun:test";
import { classifyRalphIterationOutput, hasDoneSignal, parseSubtasks } from "../../src/ralph-control.js";

describe("parseSubtasks", () => {
  test("extracts non-empty lines from the first subtasks block", () => {
    const output = "preamble\n<subtasks>\n one \n\n two \n</subtasks>\n<subtasks>ignored</subtasks>";
    expect(parseSubtasks(output)).toEqual(["one", "two"]);
  });

  test("returns an empty array when no subtasks block exists", () => {
    expect(parseSubtasks("plain output")).toEqual([]);
  });
});

describe("hasDoneSignal", () => {
  test("requires a non-empty done block", () => {
    expect(hasDoneSignal("<done>implemented and tested</done>")).toBe(true);
    expect(hasDoneSignal("<done>\n\n</done>")).toBe(false);
    expect(hasDoneSignal("agent exited zero but omitted control output")).toBe(false);
  });
});

describe("classifyRalphIterationOutput", () => {
  test("treats explicit done as completed", () => {
    expect(classifyRalphIterationOutput("<done>task complete</done>")).toEqual({ kind: "done" });
  });

  test("treats subtasks as expansion instead of completion", () => {
    expect(classifyRalphIterationOutput("<subtasks>\nadd tests\nimplement fix\n</subtasks>")).toEqual({
      kind: "subtasks",
      subtasks: ["add tests", "implement fix"],
    });
  });

  test("zero-exit prose without done/subtasks is not completion", () => {
    expect(classifyRalphIterationOutput("I looked around and did nothing.")).toEqual({
      kind: "incomplete",
      reason: "missing non-empty <done> or <subtasks> control block",
    });
  });
});
