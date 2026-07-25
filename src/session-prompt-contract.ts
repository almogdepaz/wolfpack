import {
  MAX_INITIAL_PROMPT_LENGTH,
  MAX_SESSION_NAME_LENGTH,
} from "./validation.js";

export const SESSION_PROMPT_MAX_TIMEOUT_MS = 600_000;
export const SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS = 64 * 1024;
export const SESSION_PROMPT_SELECTOR_MAX_CHARS = MAX_SESSION_NAME_LENGTH;
const UTF8_MAX_BYTES_PER_CODE_POINT = 4;
const UTF8_STREAM_ALIGNMENT_BYTES = UTF8_MAX_BYTES_PER_CODE_POINT - 1;
export const SESSION_PROMPT_PENDING_OUTPUT_MAX_BYTES =
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS * UTF8_MAX_BYTES_PER_CODE_POINT
  + UTF8_STREAM_ALIGNMENT_BYTES;

function isLeadingSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isTrailingSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export function unicodeCodePointLength(value: string): number {
  let length = 0;
  let offset = 0;
  while (offset < value.length) {
    const leadingUnit = value.charCodeAt(offset++);
    if (isLeadingSurrogate(leadingUnit) && offset < value.length) {
      const trailingUnit = value.charCodeAt(offset);
      if (isTrailingSurrogate(trailingUnit)) offset++;
    }
    length++;
  }
  return length;
}

export function unicodeCodePointSuffix(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  if (value.length <= maxCodePoints) return value;
  let start = value.length;
  let remaining = maxCodePoints;
  while (start > 0 && remaining > 0) {
    start--;
    const trailingUnit = value.charCodeAt(start);
    if (isTrailingSurrogate(trailingUnit) && start > 0) {
      const leadingUnit = value.charCodeAt(start - 1);
      if (isLeadingSurrogate(leadingUnit)) start--;
    }
    remaining--;
  }
  return start === 0 ? value : value.slice(start);
}

// JSON may encode one Unicode character as twelve bytes when an astral symbol
// is represented by two surrogate escapes (for example, "\\ud83d\\ude80").
// Include every optional property so compact encodings of all schema-valid values fit.
const MAX_JSON_STRING_CHARACTER_BYTES = 12;
const SESSION_PROMPT_JSON_SHELL_BYTES = JSON.stringify({
  session: "",
  prompt: "",
  outputContains: "",
  noEnter: false,
  timeoutMs: SESSION_PROMPT_MAX_TIMEOUT_MS,
}).length;
const SESSION_PROMPT_MAX_STRING_CHARACTERS = SESSION_PROMPT_SELECTOR_MAX_CHARS
  + MAX_INITIAL_PROMPT_LENGTH
  + SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS;
export const SESSION_PROMPT_MAX_REQUEST_BODY_BYTES = SESSION_PROMPT_JSON_SHELL_BYTES
  + MAX_JSON_STRING_CHARACTER_BYTES * SESSION_PROMPT_MAX_STRING_CHARACTERS;

export const SESSION_PROMPT_OUTCOME = {
  MATCHED: "matched",
  TIMED_OUT: "timed_out",
  TARGET_EXITED: "target_exited",
  TARGET_UNAVAILABLE: "target_unavailable",
  REPLAY_GAP: "replay_gap",
  BACKEND_UNAVAILABLE: "backend_unavailable",
} as const;

export type SessionPromptOutcome =
  (typeof SESSION_PROMPT_OUTCOME)[keyof typeof SESSION_PROMPT_OUTCOME];

export interface SessionPromptWaitOptions {
  readonly prompt: string;
  readonly outputContains: string;
  readonly noEnter: boolean;
  readonly timeoutMs: number;
}

export interface SessionPromptWaitResult {
  readonly outcome: SessionPromptOutcome;
  readonly outputBoundarySeq: string | null;
}
