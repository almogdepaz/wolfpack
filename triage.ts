// Session triage classification — shared between serve.ts and tests

export type TriageStatus = "needs-input" | "error" | "running" | "idle";

export const INPUT_PATTERNS = [
  /\? \(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /Do you want to/i,
  /Press Enter/i,
  /permission/i,
  /approve/i,
  /waiting for/i,
  /\(yes\/no\)/i,
  /\? $/,
];

export const ERROR_PATTERNS = [
  /Error:/i,
  /error\[/i,
  /\bfailed\b/i,
  /❌/,
  /panic:/i,
  /FATAL/,
  /unhandled/i,
  /segfault/i,
];

export const RUNNING_THRESHOLD_S = 20;

export function classifySession(lastLine: string, activityAge: number): TriageStatus {
  if (INPUT_PATTERNS.some((p) => p.test(lastLine))) return "needs-input";
  if (ERROR_PATTERNS.some((p) => p.test(lastLine))) return "error";
  if (activityAge <= RUNNING_THRESHOLD_S) return "running";
  return "idle";
}

export const TRIAGE_ORDER: Record<TriageStatus, number> = {
  "needs-input": 0,
  "error": 1,
  "running": 2,
  "idle": 3,
};
