import { describe, expect, test } from "bun:test";
import { classifyRalphResponseResult, parseRalphResponseJson } from "../../src/ralph-response.js";

describe("parseRalphResponseJson", () => {
  test("extracts subtasks from the structured response file", () => {
    const parsed = parseRalphResponseJson(JSON.stringify({
      version: 1,
      status: "needs_subtasks",
      prereqs: ["repo builds locally"],
      tests: ["bun test"],
      done: ["runner appends subtasks"],
      subtasks: ["add parser tests", "wire response file into runner"],
    }));

    expect(parsed).toEqual({
      ok: true,
      response: {
        version: 1,
        status: "needs_subtasks",
        prereqs: ["repo builds locally"],
        tests: ["bun test"],
        done: ["runner appends subtasks"],
        subtasks: ["add parser tests", "wire response file into runner"],
      },
    });
  });

  test("rejects invalid json instead of treating stdout prose as control data", () => {
    expect(parseRalphResponseJson("<subtasks>lol no</subtasks>")).toEqual({
      ok: false,
      error: "response file is not valid json",
    });
  });

  test("rejects needs_subtasks responses without string subtasks", () => {
    expect(parseRalphResponseJson(JSON.stringify({
      version: 1,
      status: "needs_subtasks",
      prereqs: [],
      tests: [],
      done: [],
      subtasks: ["good", 42],
    }))).toEqual({
      ok: false,
      error: "response subtasks must be an array of strings",
    });
  });

  test("accepts done responses without subtasks", () => {
    const parsed = parseRalphResponseJson(JSON.stringify({
      version: 1,
      status: "done",
      prereqs: [],
      tests: ["bun test tests/unit/ralph-response.test.ts"],
      done: ["task complete"],
      subtasks: [],
    }));

    expect(parsed).toEqual({
      ok: true,
      response: {
        version: 1,
        status: "done",
        prereqs: [],
        tests: ["bun test tests/unit/ralph-response.test.ts"],
        done: ["task complete"],
        subtasks: [],
      },
    });
  });

  test("classifies missing response files as not completed", () => {
    expect(classifyRalphResponseResult({ ok: true, response: null })).toEqual({
      kind: "not_completed",
      reason: "missing ralph response file",
    });
  });

  test("classifies invalid response files as not completed", () => {
    expect(classifyRalphResponseResult({ ok: false, error: "response file is not valid json" })).toEqual({
      kind: "not_completed",
      reason: "invalid ralph response file: response file is not valid json",
    });
  });

  test("classifies done responses as completed", () => {
    const parsed = parseRalphResponseJson(JSON.stringify({
      version: 1,
      status: "done",
      prereqs: [],
      tests: [],
      done: ["task complete"],
      subtasks: [],
    }));

    expect(classifyRalphResponseResult(parsed)).toEqual({ kind: "done" });
  });

  test("classifies needs_subtasks responses as subtask expansion", () => {
    const parsed = parseRalphResponseJson(JSON.stringify({
      version: 1,
      status: "needs_subtasks",
      prereqs: [],
      tests: [],
      done: [],
      subtasks: ["one", "two"],
    }));

    expect(classifyRalphResponseResult(parsed)).toEqual({
      kind: "subtasks",
      subtasks: ["one", "two"],
    });
  });
});
