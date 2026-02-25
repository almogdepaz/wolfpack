// Session triage classification — shared between serve.ts and tests

export type TriageStatus = "needs-input" | "error" | "running" | "idle";

export const INPUT_PATTERNS = [
  /\? ?\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /Do you want to (?:continue|proceed|install|update|overwrite|replace|delete|remove|retry|upgrade|deploy)/i,
  /Press (?:Enter|ENTER|any key)/i,
  /(?:grant|request|need).*permission/i,
  /(?:approve|confirm) (?:this|the)/i,
  /waiting for (?:input|response|confirmation|approval)/i,
  /\(yes\/no(?:\/\w+)?\)/i,
  /\?\s*\[.*\]\s*$/,
];

export const ERROR_PATTERNS = [
  /(?:^|:\s*)Error:/,
  /error\[E?\d+\]/i,
  /(?:build|test|compile|deploy|install|command) failed/i,
  /❌/,
  /panic:/i,
  /FATAL/,
  /unhandled (?:exception|rejection|error)/i,
  /segfault|segmentation fault/i,
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
