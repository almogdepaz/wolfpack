// Session triage classification — shared between server and tests

export type TriageStatus = "running" | "idle";

/** Patterns matching decorative/UI lines to filter from card preview. */
export const JUNK_LINE_PATTERNS = [
  /^[─━═│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰║╒╓╘╙╕╖╛╜\s]+$/, // all box-drawing chars
  /⏵⏵\s*accept edits/,                               // Claude Code hint bar
  /esc to interrupt/,                                  // Claude Code hint bar
  /^\s*[$%#>❯›»]\s*$/,                                // bare shell/agent prompt
  /^\s*$/,                                             // whitespace-only
];

/** True if the line is decorative/UI junk that should be filtered from card preview. */
export function isJunkLine(line: string): boolean {
  return JUNK_LINE_PATTERNS.some((p) => p.test(line));
}

