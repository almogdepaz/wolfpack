/**
 * Pure functions for terminal input handling.
 * Imported directly by both the browser frontend and unit tests.
 */
import { PTY_BINARY_FRAME_MAX_BYTES } from "./ws-constants";

/**
 * Decide whether a key event should be intercepted for clipboard copy.
 * Returns true when Cmd/Ctrl+C is pressed on keydown with an active selection.
 */
export function shouldInterceptCopy(
  event: { metaKey: boolean; ctrlKey: boolean; key: string; type: string },
  hasSelection: boolean,
): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "c" && event.type === "keydown" && hasSelection;
}

export interface TerminalScrollLockKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
}

/** Command is a browser modifier and must not abandon terminal scrollback. */
export function shouldReleaseScrollLockOnKeydown(event: TerminalScrollLockKeyEvent): boolean {
  return event.key !== "Meta" && !event.metaKey;
}

/**
 * Encode a binary string (from terminal onBinary callback) to a Uint8Array.
 * Each character's code point is masked to the low byte via & 0xff.
 */
export function encodeTerminalBinary(data: string): Uint8Array {
  const buf = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
  return buf;
}

export function splitTerminalInputBytes(
  data: Uint8Array,
  maxBytes: number = PTY_BINARY_FRAME_MAX_BYTES,
): Uint8Array[] {
  if (maxBytes <= 0) throw new RangeError("maxBytes must be positive");
  if (data.length <= maxBytes) return [data];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += maxBytes) {
    chunks.push(data.subarray(offset, Math.min(offset + maxBytes, data.length)));
  }
  return chunks;
}

export interface TerminalBeforeInputEvent {
  readonly inputType: string;
  readonly data: string | null;
  readonly isComposing: boolean;
}

export function terminalDataFromBeforeInput(event: TerminalBeforeInputEvent): string | null {
  if (event.isComposing) return null;
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromPaste":
      return event.data && event.data.length > 0 ? event.data.replace(/\n/g, "\r") : null;
    case "insertLineBreak":
    case "insertParagraph":
      return "\r";
    case "deleteContentBackward":
      return "\x7f";
    case "deleteContentForward":
      return "\x1b[3~";
    default:
      return null;
  }
}

export interface TerminalKeydownDedupeEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
}

export function terminalDataFromKeydownForBeforeInputDedupe(event: TerminalKeydownDedupeEvent): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (!(event.ctrlKey && !event.altKey) && !(event.altKey && !event.ctrlKey) && !event.metaKey && event.key.length === 1) {
    return event.key;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.code) {
    case "Enter":
    case "NumpadEnter":
      return "\r";
    case "Tab":
      return "\t";
    case "Backspace":
      return "\x7f";
    case "Delete":
      return "\x1b[3~";
    default:
      return null;
  }
}

export interface MessageInputEnterEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly enterSends: boolean;
  readonly isDesktop: boolean;
}

/**
 * Decide whether textarea Enter submits a prompt.
 * The mobile accessory row has separate handling for inserting textarea newlines.
 */
export function shouldSubmitMessageInputOnEnter(event: MessageInputEnterEvent): boolean {
  if (event.key !== "Enter") return false;
  return event.enterSends ? !event.shiftKey : event.shiftKey;
}

export interface KeyboardAccessoryKeyEvent {
  readonly key: string;
  readonly isMessageInputActive: boolean;
  readonly hasMessageInputDraft?: boolean;
}

export function shouldInsertMessageNewlineFromAccessoryKey(event: KeyboardAccessoryKeyEvent): boolean {
  return event.key === "Enter" && (event.isMessageInputActive || !!event.hasMessageInputDraft);
}
