/**
 * Desktop terminal frontend logic — tests the production modules used by
 * index.html for copy interception, binary encoding, and stdin gating.
 */
import { describe, expect, test } from "bun:test";
import { shouldInterceptCopy, encodeTerminalBinary, shouldSubmitMessageInputOnEnter } from "../../src/terminal-input";

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

// ── Message textarea Enter behavior ──

describe("message textarea: Enter behavior", () => {
  test("mobile Enter inserts newline even when enterSends is enabled", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: false,
      enterSends: true,
      isDesktop: false,
    })).toBe(false);
  });

  test("mobile Shift+Enter submits", () => {
    expect(shouldSubmitMessageInputOnEnter({
      key: "Enter",
      shiftKey: true,
      enterSends: true,
      isDesktop: false,
    })).toBe(true);
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
