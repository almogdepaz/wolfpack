/**
 * Pure functions for terminal input handling.
 * Used by both the browser frontend (via wolfpack-lib.js bundle)
 * and unit tests (via direct import).
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
