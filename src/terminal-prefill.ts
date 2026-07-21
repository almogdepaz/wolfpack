export const TERMINAL_PREFILL_MODE = {
  FULL: "full",
  VIEWPORT: "viewport",
  NONE: "none",
} as const;

export const TERMINAL_PREFILL_MODES = [
  TERMINAL_PREFILL_MODE.FULL,
  TERMINAL_PREFILL_MODE.VIEWPORT,
  TERMINAL_PREFILL_MODE.NONE,
] as const;

export type TerminalPrefillMode = typeof TERMINAL_PREFILL_MODES[number];

export const CLI_ATTACH_PREFILL_MODES = [
  TERMINAL_PREFILL_MODE.FULL,
  TERMINAL_PREFILL_MODE.NONE,
] as const;

export type CliAttachPrefillMode = typeof CLI_ATTACH_PREFILL_MODES[number];

const TERMINAL_PREFILL_MODE_SET: ReadonlySet<string> = new Set(TERMINAL_PREFILL_MODES);
const CLI_ATTACH_PREFILL_MODE_SET: ReadonlySet<string> = new Set(CLI_ATTACH_PREFILL_MODES);

export function isTerminalPrefillMode(value: string): value is TerminalPrefillMode {
  return TERMINAL_PREFILL_MODE_SET.has(value);
}

export function isCliAttachPrefillMode(value: string): value is CliAttachPrefillMode {
  return CLI_ATTACH_PREFILL_MODE_SET.has(value);
}
