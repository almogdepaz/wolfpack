/**
 * snapshot-render unit tests — fixture-driven assertions on the byte
 * sequence we feed to a fresh terminal to reconstruct a broker snapshot.
 */
import { describe, expect, test } from "bun:test";

import {
  renderSnapshotToAnsi,
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
  test("emits scrollback as plain lines with CRLF (no SGR)", () => {
    const snap: SnapshotForRender = {
      scrollback: [row("first"), row("second")],
      visible_screen: [],
      cursor: { row: 0, col: 0 },
    };
    const out = decode(renderSnapshotToAnsi(snap));
    // Scrollback section should be plaintext, separated by \r\n.
    expect(out).toContain("first\r\nsecond\r\n");
    // No SGR escape sequences except the leading reset and the trailing
    // cursor-shape sequence.
    const ansiBetween = out.split("\x1b[0m")[1] ?? "";
    expect(ansiBetween.indexOf("\x1b[0;")).toBe(-1);
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
