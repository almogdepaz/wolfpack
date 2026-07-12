/**
 * snapshot-render unit tests — fixture-driven assertions on the byte
 * sequence we feed to a fresh terminal to reconstruct a broker snapshot.
 */
import { describe, expect, test } from "bun:test";

import {
  renderSnapshotToAnsi,
  renderSnapshotToPlainText,
  type SnapshotForRender,
  type StyledLine,
  type CellAttrs,
} from "../../src/broker/snapshot-render";

function row(text: string, attrs?: CellAttrs): StyledLine {
  return {
    cells: text.split("").map((ch) => ({ ch, attrs: attrs ?? {} })),
  };
}

function styledRow(cells: Array<{ ch: string; attrs?: CellAttrs }>): StyledLine {
  return { cells };
}

function decode(buf: Buffer): string {
  return buf.toString("utf8");
}

describe("renderSnapshotToAnsi: preamble", () => {
  test("starts with clear-visible + clear-scrollback + cursor-home + SGR reset", () => {
    const snap: SnapshotForRender = { visible_screen: [], scrollback: [], cursor: { row: 0, col: 0 } };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.startsWith("\x1b[2J\x1b[3J\x1b[H\x1b[0m")).toBe(true);
  });
});

describe("renderSnapshotToAnsi: scrollback rendering", () => {
  test("emits default-attrs scrollback as plain lines with CRLF and no extra SGR", () => {
    const snap: SnapshotForRender = {
      scrollback: [row("first"), row("second")],
      visible_screen: [],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // Default-attrs scrollback should appear unstyled, separated by \r\n.
    expect(out).toContain("first\r\nsecond\r\n");
    // Default-attrs cells must not emit SGR transitions.
    const ansiBetween = out.split("\x1b[0m")[1] ?? "";
    expect(ansiBetween.indexOf("\x1b[0;")).toBe(-1);
  });

  test("emits SGR for styled scrollback cells (preserves color through history)", () => {
    const snap: SnapshotForRender = {
      scrollback: [
        styledRow([
          { ch: "g", attrs: { fg: 0x00ff00 } },
          { ch: "r", attrs: { fg: 0x00ff00 } },
          { ch: "n", attrs: { fg: 0x00ff00 } },
        ]),
      ],
      visible_screen: [],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // SGR transition for the green fg before the chars
    expect(out).toContain("\x1b[0;38;2;0;255;0mgrn");
  });

  test("emits a wide-grapheme lead once and ignores its continuation cell", () => {
    const snap: SnapshotForRender = {
      scrollback: [styledRow([{ ch: "界", attrs: {} }, { ch: "", attrs: {} }, { ch: "x", attrs: {} }])],
      visible_screen: [],
      cursor: { row: 0, col: 3 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out).toContain("界x\r\n");
    expect(out).not.toContain("界界x");
  });

  test("trims trailing pad-spaces in scrollback lines", () => {
    const snap: SnapshotForRender = {
      scrollback: [row("hello       ")],
      visible_screen: [],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out).toContain("hello\r\n");
    expect(out).not.toContain("hello       \r\n");
  });
});

describe("renderSnapshotToAnsi: visible_screen SGR transitions", () => {
  test("emits no SGR for an all-default visible screen", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("hi")],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // After the preamble there should be no further SGR before cursor positioning.
    const afterPreamble = out.slice("\x1b[2J\x1b[3J\x1b[H\x1b[0m".length);
    expect(afterPreamble.startsWith("hi")).toBe(true);
  });

  test("emits a single SGR transition when a styled run begins", () => {
    const snap: SnapshotForRender = {
      visible_screen: [
        styledRow([
          { ch: "a", attrs: {} },
          { ch: "b", attrs: { bold: true } },
          { ch: "c", attrs: { bold: true } },
          { ch: "d", attrs: {} },
        ]),
      ],
      cursor: { row: 0, col: 4 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // 'a' is default, then SGR(bold) before 'b', no SGR between 'b' and 'c',
    // then SGR(reset) before 'd'.
    expect(out).toContain("a\x1b[0;1mbc\x1b[0md");
  });

  test("encodes 24-bit fg/bg colors as truecolor SGR params", () => {
    const snap: SnapshotForRender = {
      visible_screen: [
        styledRow([
          { ch: "x", attrs: { fg: 0xff0000 } },
          { ch: "y", attrs: { fg: 0xff0000, bg: 0x0000ff } },
        ]),
      ],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out).toContain("\x1b[0;38;2;255;0;0mx");
    expect(out).toContain("\x1b[0;38;2;255;0;0;48;2;0;0;255my");
  });

  test("separates visible_screen rows with CRLF and trailing reset", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("AA"), row("BB")],
      cursor: { row: 1, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out).toContain("AA\r\nBB");
    // No CRLF after the last row so the cursor positioning isn't pushed off.
    expect(out.endsWith("BB\r\n\x1b[2;1H\x1b[?25h")).toBe(false);
  });

  test("emits an SGR reset before cursor positioning if the last cell was styled", () => {
    const snap: SnapshotForRender = {
      visible_screen: [
        styledRow([{ ch: "z", attrs: { bold: true, fg: 0x00ff00 } }]),
      ],
      cursor: { row: 0, col: 1 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // Sequence ends: …<styled cell><SGR reset><cursor pos><cursor visible>
    expect(out).toMatch(/z\x1b\[0m\x1b\[1;2H\x1b\[\?25h$/);
  });
});

describe("renderSnapshotToAnsi: cursor positioning", () => {
  test("uses 1-based row;col for CSI H", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("a"), row("b"), row("c")],
      cursor: { row: 2, col: 5 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.endsWith("\x1b[3;6H\x1b[?25h")).toBe(true);
  });

  test("hides the cursor when cursor.visible is false", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0, visible: false },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.endsWith("\x1b[1;1H\x1b[?25l")).toBe(true);
  });

  test("clamps negative cursor coordinates to 0,0", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: -1, col: -10 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.endsWith("\x1b[1;1H\x1b[?25h")).toBe(true);
  });

  test("omits cursor positioning when snapshot has no cursor", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.indexOf("\x1b[?25")).toBe(-1);
    expect(out.indexOf(";1H")).toBe(-1);
  });
});

describe("renderSnapshotToAnsi: alt-screen handling", () => {
  test("omits CSI ?1049h when modes.alt_screen is unset/false", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("primary")],
      scrollback: [row("history")],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.includes("\x1b[?1049h")).toBe(false);
  });

  test("emits CSI ?1049h after scrollback, before visible cells, when on alt screen", () => {
    // Captured on alt: scrollback is the primary's history (painted first on
    // primary), then we switch into alt and paint visible cells there.
    const snap: SnapshotForRender = {
      scrollback: [row("primary history line 1")],
      visible_screen: [row("alt screen contents")],
      cursor: { row: 0, col: 0 },
      modes: { alt_screen: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    const idxScrollback = out.indexOf("primary history line 1");
    const idxAltSwitch = out.indexOf("\x1b[?1049h");
    const idxVisible = out.indexOf("alt screen contents");
    expect(idxScrollback).toBeGreaterThanOrEqual(0);
    expect(idxAltSwitch).toBeGreaterThan(idxScrollback);
    expect(idxVisible).toBeGreaterThan(idxAltSwitch);
  });

  test("alt-screen snapshot with empty scrollback still switches to alt before painting", () => {
    const snap: SnapshotForRender = {
      scrollback: [],
      visible_screen: [row("alt-only")],
      cursor: { row: 0, col: 0 },
      modes: { alt_screen: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    const idxAltSwitch = out.indexOf("\x1b[?1049h");
    const idxVisible = out.indexOf("alt-only");
    expect(idxAltSwitch).toBeGreaterThan(0);
    expect(idxVisible).toBeGreaterThan(idxAltSwitch);
  });
});

describe("renderSnapshotToAnsi: DEC mode preamble", () => {
  test("omits all mode escapes when modes block is absent", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // No application-cursor / mouse / bracketed-paste / keypad escapes.
    expect(out.includes("\x1b[?1h")).toBe(false);
    expect(out.includes("\x1b[?1000h")).toBe(false);
    expect(out.includes("\x1b[?1006h")).toBe(false);
    expect(out.includes("\x1b[?2004h")).toBe(false);
    expect(out.includes("\x1b=")).toBe(false);
  });

  test("emits DECCKM (?1h) when application_cursor is true", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { application_cursor: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    const idxMode = out.indexOf("\x1b[?1h");
    const idxCursor = out.indexOf("\x1b[1;1H");
    expect(idxMode).toBeGreaterThan(0);
    expect(idxCursor).toBeGreaterThan(idxMode);
  });

  test("emits bracketed-paste (?2004h) when bracketed_paste is true", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { bracketed_paste: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.includes("\x1b[?2004h")).toBe(true);
  });

  test("emits SGR mouse pair (?1000h + ?1006h) when mouse_mode is sgr", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { mouse_mode: "sgr" },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.includes("\x1b[?1000h")).toBe(true);
    expect(out.includes("\x1b[?1006h")).toBe(true);
  });

  test("emits button-event mouse (?1002h) when mouse_mode is button_event", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { mouse_mode: "button_event" },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.includes("\x1b[?1002h")).toBe(true);
    // Should not redundantly emit ?1000h or ?1006h.
    expect(out.includes("\x1b[?1000h")).toBe(false);
    expect(out.includes("\x1b[?1006h")).toBe(false);
  });

  test("emits application-keypad (ESC =) when application_keypad is true", () => {
    const snap: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { application_keypad: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    expect(out.includes("\x1b=")).toBe(true);
  });

  test("emits CSI ?7l only when auto_wrap is explicitly false (default-true is silent)", () => {
    const enabled: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { auto_wrap: true },
    };
    expect(decode(renderSnapshotToAnsi(enabled)).includes("\x1b[?7l")).toBe(false);

    const disabled: SnapshotForRender = {
      visible_screen: [row("x")],
      cursor: { row: 0, col: 0 },
      modes: { auto_wrap: false },
    };
    expect(decode(renderSnapshotToAnsi(disabled)).includes("\x1b[?7l")).toBe(true);
  });

  test("mode preamble is emitted between visible cells and cursor positioning", () => {
    // Origin mode affects cursor placement, so DECOM must be set BEFORE the
    // final CUP. Mouse / paste / keypad don't affect rendering but must land
    // before the cursor sequence too so they're stable when live bytes arrive.
    const snap: SnapshotForRender = {
      visible_screen: [row("hello")],
      cursor: { row: 1, col: 2 },
      modes: { origin_mode: true, bracketed_paste: true },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    const idxVisible = out.indexOf("hello");
    const idxOrigin = out.indexOf("\x1b[?6h");
    const idxPaste = out.indexOf("\x1b[?2004h");
    const idxCursor = out.indexOf("\x1b[2;3H");
    expect(idxVisible).toBeGreaterThan(0);
    expect(idxOrigin).toBeGreaterThan(idxVisible);
    expect(idxPaste).toBeGreaterThan(idxVisible);
    expect(idxCursor).toBeGreaterThan(idxOrigin);
    expect(idxCursor).toBeGreaterThan(idxPaste);
  });
});

describe("renderSnapshotToAnsi: full fixture", () => {
  test("scrollback + styled visible + cursor reconstruction", () => {
    const snap: SnapshotForRender = {
      cols: 4,
      rows: 2,
      scrollback: [row("old line 1"), row("old line 2")],
      visible_screen: [
        styledRow([
          { ch: "h", attrs: {} },
          { ch: "i", attrs: { bold: true, fg: 0xffffff } },
        ]),
        styledRow([
          { ch: "!", attrs: { bg: 0x000080 } },
        ]),
      ],
      cursor: { row: 1, col: 1, visible: true },
    };
    const got = decode(renderSnapshotToAnsi(snap));
    const expected =
      "\x1b[2J\x1b[3J\x1b[H\x1b[0m" +
      "old line 1\r\n" +
      "old line 2\r\n" +
      "h\x1b[0;1;38;2;255;255;255mi" +
      "\r\n" +
      "\x1b[0;48;2;0;0;128m!" +
      "\x1b[0m" +
      "\x1b[2;2H\x1b[?25h";
    expect(got).toBe(expected);
  });
});

describe("renderSnapshotToPlainText", () => {
  test("emits scrollback then visible screen as plain LF-separated lines", () => {
    const snap: SnapshotForRender = {
      scrollback: [row("history one"), row("history two")],
      visible_screen: [row("$ echo hi"), row("hi"), row("$ ")],
      cursor: { row: 2, col: 2 },
    };
    const out = renderSnapshotToPlainText(snap);
    expect(out).toBe(["history one", "history two", "$ echo hi", "hi", "$"].join("\n"));
  });

  test("strips trailing pad spaces and trailing blank rows", () => {
    const snap: SnapshotForRender = {
      scrollback: [],
      visible_screen: [
        row("only meaningful   "),
        row(""),
        row("       "),
      ],
      cursor: { row: 0, col: 0 },
    };
    expect(renderSnapshotToPlainText(snap)).toBe("only meaningful");
  });

  test("contains no ANSI escape sequences", () => {
    const snap: SnapshotForRender = {
      scrollback: [],
      visible_screen: [
        styledRow([
          { ch: "h" },
          { ch: "i", attrs: { fg: 0xffffff, bold: true } },
        ]),
      ],
      cursor: { row: 0, col: 2 },
    };
    expect(renderSnapshotToPlainText(snap)).toBe("hi");
    expect(renderSnapshotToPlainText(snap).indexOf("\x1b")).toBe(-1);
  });
});
