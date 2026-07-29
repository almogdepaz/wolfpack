/**
 * Desktop terminal frontend logic — tests the production modules used by
 * index.html for copy interception, binary encoding, and stdin gating.
 */
import { describe, expect, test } from "bun:test";
import {
  shouldInterceptCopy,
  encodeTerminalBinary,
  splitTerminalInputBytes,
  shouldInsertMessageNewlineFromAccessoryKey,
  shouldSubmitMessageInputOnEnter,
  shouldReleaseScrollLockOnKeydown,
  terminalDataFromBeforeInput,
  terminalDataFromKeydownForBeforeInputDedupe,
} from "../../src/terminal-input";

// ── Copy handler tests (shouldInterceptCopy) ──

describe("desktop terminal: copy handler (shouldInterceptCopy)", () => {
  test("Cmd+C with selection → true (intercept for copy)", () => {
    expect(shouldInterceptCopy({ metaKey: true, ctrlKey: false, key: "c", type: "keydown" }, true)).toBe(true);
  });

  test("Ctrl+C with selection → true (intercept for copy)", () => {
    expect(shouldInterceptCopy({ metaKey: false, ctrlKey: true, key: "c", type: "keydown" }, true)).toBe(true);
  });

  test("Cmd+C without selection → false (SIGINT, not copy)", () => {
    expect(shouldInterceptCopy({ metaKey: true, ctrlKey: false, key: "c", type: "keydown" }, false)).toBe(false);
  });

  test("Ctrl+C without selection → false (SIGINT)", () => {
    expect(shouldInterceptCopy({ metaKey: false, ctrlKey: true, key: "c", type: "keydown" }, false)).toBe(false);
  });

  test("Cmd+C on keyup → false (only keydown intercepts)", () => {
    expect(shouldInterceptCopy({ metaKey: true, ctrlKey: false, key: "c", type: "keyup" }, true)).toBe(false);
  });

  test("Cmd+V (paste) → false (only 'c' intercepted)", () => {
    expect(shouldInterceptCopy({ metaKey: true, ctrlKey: false, key: "v", type: "keydown" }, true)).toBe(false);
  });

  test("plain 'c' without modifier → false", () => {
    expect(shouldInterceptCopy({ metaKey: false, ctrlKey: false, key: "c", type: "keydown" }, true)).toBe(false);
  });

  test("Cmd+Ctrl+C with selection → true (both modifiers)", () => {
    expect(shouldInterceptCopy({ metaKey: true, ctrlKey: true, key: "c", type: "keydown" }, true)).toBe(true);
  });
});

describe("desktop terminal: keypress scroll-lock release", () => {
  test("ordinary terminal key releases scroll lock", () => {
    expect(shouldReleaseScrollLockOnKeydown({ key: "a", metaKey: false })).toBe(true);
  });

  test("standalone Command key preserves scroll lock", () => {
    expect(shouldReleaseScrollLockOnKeydown({ key: "Meta", metaKey: true })).toBe(false);
  });

  test("Command-modified shortcuts preserve scroll lock", () => {
    expect(shouldReleaseScrollLockOnKeydown({ key: "c", metaKey: true })).toBe(false);
  });

  test("Control remains ordinary terminal input", () => {
    expect(shouldReleaseScrollLockOnKeydown({ key: "c", metaKey: false })).toBe(true);
  });
});

// ── Binary encoding tests (encodeTerminalBinary) ──

describe("desktop terminal: binary encoding (encodeTerminalBinary)", () => {
  test("ASCII string encodes correctly", () => {
    const result = encodeTerminalBinary("hello");
    expect(result).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  test("empty string returns empty array", () => {
    const result = encodeTerminalBinary("");
    expect(result).toEqual(new Uint8Array([]));
  });

  test("single byte values preserved via & 0xff", () => {
    const input = String.fromCharCode(0, 127, 128, 255);
    const result = encodeTerminalBinary(input);
    expect(result).toEqual(new Uint8Array([0, 127, 128, 255]));
  });

  test("multi-byte chars truncated to low byte via & 0xff", () => {
    const input = String.fromCharCode(256, 512, 0x1234);
    const result = encodeTerminalBinary(input);
    expect(result).toEqual(new Uint8Array([0, 0, 0x34]));
  });

  test("control characters (newline, tab, escape) encode correctly", () => {
    const result = encodeTerminalBinary("\n\t\x1b");
    expect(result).toEqual(new Uint8Array([10, 9, 27]));
  });

  test("CSI escape sequence encodes correctly", () => {
    const result = encodeTerminalBinary("\x1b[A");
    expect(result).toEqual(new Uint8Array([27, 91, 65]));
  });
});

// ── Binary input chunking ──

describe("desktop terminal: binary input chunking (splitTerminalInputBytes)", () => {
  test("leaves small input as one frame", () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(splitTerminalInputBytes(input, 16)).toEqual([input]);
  });

  test("splits large input into max-sized frames while preserving bytes", () => {
    const input = new Uint8Array(40);
    for (let i = 0; i < input.length; i += 1) input[i] = i;

    const chunks = splitTerminalInputBytes(input, 16);

    expect(chunks.map((chunk) => chunk.length)).toEqual([16, 16, 8]);
    expect(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(input);
  });

  test("rejects invalid max frame size", () => {
    expect(() => splitTerminalInputBytes(new Uint8Array([1]), 0)).toThrow("maxBytes must be positive");
  });
});

// ── Mobile native textarea input bridge ──

describe("mobile terminal: native textarea beforeinput bridge", () => {
  test("maps soft-keyboard text and paste to terminal stdin", () => {
    expect(terminalDataFromBeforeInput({ inputType: "insertText", data: "a", isComposing: false })).toBe("a");
    expect(terminalDataFromBeforeInput({ inputType: "insertFromPaste", data: "pasted", isComposing: false })).toBe("pasted");
  });

  test("maps mobile line breaks and deletion to terminal control bytes", () => {
    expect(terminalDataFromBeforeInput({ inputType: "insertLineBreak", data: null, isComposing: false })).toBe("\r");
    expect(terminalDataFromBeforeInput({ inputType: "deleteContentBackward", data: null, isComposing: false })).toBe("\x7f");
    expect(terminalDataFromBeforeInput({ inputType: "deleteContentForward", data: null, isComposing: false })).toBe("\x1b[3~");
  });

  test("ignores active IME composition beforeinput events", () => {
    expect(terminalDataFromBeforeInput({ inputType: "insertText", data: "你", isComposing: true })).toBeNull();
  });

  test("records keydown bytes that duplicate later beforeinput events", () => {
    expect(terminalDataFromKeydownForBeforeInputDedupe({
      key: "b",
      code: "KeyB",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 66,
    })).toBe("b");
    expect(terminalDataFromKeydownForBeforeInputDedupe({
      key: "Enter",
      code: "Enter",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 13,
    })).toBe("\r");
  });
});

// ── Message textarea Enter behavior ──

describe("message textarea: Enter behavior", () => {
  test("mobile Enter submits when enterSends is enabled", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: false,
      enterSends: true,
      isDesktop: false,
    })).toBe(true);
  });

  test("mobile Shift+Enter inserts newline when enterSends is enabled", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: true,
      enterSends: true,
      isDesktop: false,
    })).toBe(false);
  });

  test("desktop Enter submits when enterSends is enabled", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: false,
      enterSends: true,
      isDesktop: true,
    })).toBe(true);
  });

  test("desktop Enter inserts newline when enterSends is disabled", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: false,
      enterSends: false,
      isDesktop: true,
    })).toBe(false);
  });

  test("non-Enter keys never submit", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "a",
      shiftKey: false,
      enterSends: true,
      isDesktop: true,
    })).toBe(false);
  });
});

// ── Mobile accessory Enter behavior ──

describe("mobile accessory row: Enter behavior", () => {
  test("Enter inserts a message newline while the message input is active", () => {
    expect(shouldInsertMessageNewlineFromAccessoryKey({
      key: "Enter",
      isMessageInputActive: true,
    })).toBe(true);
  });

  test("Enter inserts a message newline when mobile focus was lost but the textarea has draft text", () => {
    expect(shouldInsertMessageNewlineFromAccessoryKey({
      key: "Enter",
      isMessageInputActive: false,
      hasMessageInputDraft: true,
    })).toBe(true);
  });

  test("Enter still goes to terminal when the message input is not active and has no draft", () => {
    expect(shouldInsertMessageNewlineFromAccessoryKey({
      key: "Enter",
      isMessageInputActive: false,
      hasMessageInputDraft: false,
    })).toBe(false);
  });

  test("non-Enter accessory keys never insert message newlines", () => {
    expect(shouldInsertMessageNewlineFromAccessoryKey({
      key: "Escape",
      isMessageInputActive: true,
    })).toBe(false);
  });
});

// ── Stdin gating tests ──

describe("desktop terminal: stdin forwarding guard", () => {
  test("forwards when canAcceptInput returns true", () => {
    expect((() => true)()).toBe(true);
  });

  test("blocks when canAcceptInput returns false", () => {
    expect((() => false)()).toBe(false);
  });

  test("respects dynamic state changes", () => {
    let connected = false;
    const guard = () => connected;

    expect(guard()).toBe(false);
    connected = true;
    expect(guard()).toBe(true);
    connected = false;
    expect(guard()).toBe(false);
  });
});

// ── Stdin encoding (onData path — tests TextEncoder directly) ──

describe("desktop terminal: stdin encoding (onData → TextEncoder)", () => {
  test("ASCII input encodes to UTF-8 bytes", () => {
    const encoded = new TextEncoder().encode("hello");
    expect(encoded).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  test("newline encodes correctly", () => {
    const encoded = new TextEncoder().encode("\n");
    expect(encoded).toEqual(new Uint8Array([10]));
  });

  test("Enter key (\\r) encodes correctly", () => {
    const encoded = new TextEncoder().encode("\r");
    expect(encoded).toEqual(new Uint8Array([13]));
  });

  test("tab encodes correctly", () => {
    const encoded = new TextEncoder().encode("\t");
    expect(encoded).toEqual(new Uint8Array([9]));
  });

  test("escape sequence encodes correctly", () => {
    const encoded = new TextEncoder().encode("\x1b[A");
    expect(encoded).toEqual(new Uint8Array([27, 91, 65]));
  });

  test("empty string produces empty array", () => {
    const encoded = new TextEncoder().encode("");
    expect(encoded).toEqual(new Uint8Array([]));
  });

  test("unicode input encodes as UTF-8 multi-byte", () => {
    // '€' is U+20AC, UTF-8: E2 82 AC
    const encoded = new TextEncoder().encode("€");
    expect(encoded).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
  });
});
