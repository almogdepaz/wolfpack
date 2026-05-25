import { existsSync, readFileSync } from "node:fs";

export const RALPH_RESPONSE_VERSION = 1;

export const RalphResponseStatus = {
  done: "done",
  needsSubtasks: "needs_subtasks",
} as const;

export type RalphResponseStatus = (typeof RalphResponseStatus)[keyof typeof RalphResponseStatus];

export interface RalphIterationResponse {
  readonly version: typeof RALPH_RESPONSE_VERSION;
  readonly status: RalphResponseStatus;
  readonly prereqs: readonly string[];
  readonly tests: readonly string[];
  readonly done: readonly string[];
  readonly subtasks: readonly string[];
}

export type RalphResponseParseResult =
  | { readonly ok: true; readonly response: RalphIterationResponse }
  | { readonly ok: false; readonly error: string };

export type RalphResponseFileResult =
  | RalphResponseParseResult
  | { readonly ok: true; readonly response: null };

export type RalphResponseDecision =
  | { readonly kind: "done" }
  | { readonly kind: "subtasks"; readonly subtasks: readonly string[] }
  | { readonly kind: "not_completed"; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): readonly string[] | string {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return `response ${field} must be an array of strings`;
  }
  return value.map(item => item.trim()).filter(Boolean);
}

export function parseRalphResponseJson(content: string): RalphResponseParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "response file is not valid json" };
  }

  if (!isPlainObject(parsed)) return { ok: false, error: "response must be a json object" };
  if (parsed.version !== RALPH_RESPONSE_VERSION) return { ok: false, error: "response version must be 1" };
  if (parsed.status !== RalphResponseStatus.done && parsed.status !== RalphResponseStatus.needsSubtasks) {
    return { ok: false, error: "response status must be done or needs_subtasks" };
  }

  const prereqs = stringArray(parsed.prereqs, "prereqs");
  if (typeof prereqs === "string") return { ok: false, error: prereqs };
  const tests = stringArray(parsed.tests, "tests");
  if (typeof tests === "string") return { ok: false, error: tests };
  const done = stringArray(parsed.done, "done");
  if (typeof done === "string") return { ok: false, error: done };
  const subtasks = stringArray(parsed.subtasks, "subtasks");
  if (typeof subtasks === "string") return { ok: false, error: subtasks };

  if (parsed.status === RalphResponseStatus.needsSubtasks && subtasks.length === 0) {
    return { ok: false, error: "needs_subtasks response must include at least one subtask" };
  }

  return {
    ok: true,
    response: {
      version: RALPH_RESPONSE_VERSION,
      status: parsed.status,
      prereqs,
      tests,
      done,
      subtasks,
    },
  };
}

export function readRalphResponseFile(path: string): RalphResponseFileResult {
  if (!existsSync(path)) return { ok: true, response: null };
  return parseRalphResponseJson(readFileSync(path, "utf-8"));
}

export function classifyRalphResponseResult(result: RalphResponseFileResult): RalphResponseDecision {
  if (!result.ok) {
    return { kind: "not_completed", reason: `invalid ralph response file: ${result.error}` };
  }
  if (!result.response) {
    return { kind: "not_completed", reason: "missing ralph response file" };
  }
  if (result.response.status === RalphResponseStatus.needsSubtasks) {
    return { kind: "subtasks", subtasks: result.response.subtasks };
  }
  return { kind: "done" };
}
