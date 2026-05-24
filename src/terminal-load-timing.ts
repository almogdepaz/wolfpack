export type TerminalLoadMode = "single" | "grid" | "none" | "unknown";

export interface TerminalLoadLogFields {
  readonly event: string;
  readonly session: string;
  readonly mode: TerminalLoadMode;
  readonly tMs: number;
  readonly sinceStartMs: number;
  readonly [key: string]: unknown;
}

export function isTerminalLoadTimingEnabled(env: Record<string, string | undefined>): boolean {
  return env.WOLFPACK_TERMINAL_LOAD_DEBUG === "1";
}

export function terminalLoadModeFromPrefill(prefillMode: string | undefined): TerminalLoadMode {
  if (prefillMode === "full") return "single";
  if (prefillMode === "viewport") return "grid";
  if (prefillMode === "none") return "none";
  return "unknown";
}

export function terminalLoadTimingFields(args: {
  readonly event: string;
  readonly session: string;
  readonly mode: TerminalLoadMode;
  readonly nowMs: number;
  readonly startMs: number;
  readonly extra?: Record<string, unknown>;
}): TerminalLoadLogFields {
  return {
    ...(args.extra || {}),
    event: args.event,
    session: args.session,
    mode: args.mode,
    tMs: roundMs(args.nowMs),
    sinceStartMs: roundMs(args.nowMs - args.startMs),
  };
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
