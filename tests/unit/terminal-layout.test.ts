import { describe, expect, test } from "bun:test";
import {
  commitTerminalResizePreservingScroll,
  fitTerminalPreservingScroll,
  syncTerminalLayout,
} from "../../public/terminal-layout.ts";

describe("terminal layout", () => {
  test("preserves a scrollback reader's distance from the bottom across a fit", () => {
    let scrollbackLength = 100;
    const scrollTargets: number[] = [];
    const term = {
      cols: 80,
      rows: 24,
      viewportY: 20,
      getScrollbackLength: () => scrollbackLength,
      scrollToLine: (target: number) => { scrollTargets.push(target); },
    };

    fitTerminalPreservingScroll({
      term,
      fitAddon: {
        fit: () => {
          scrollbackLength = 140;
          term.cols = 120;
        },
      },
    });

    expect(scrollTargets).toEqual([60]);
  });

  test("does not commit proposed columns until the ordered broker resize acknowledgement", () => {
    const sent: Array<{ readonly cols: number; readonly rows: number }> = [];
    let dimensionsChanged = false;
    const term = {
      cols: 80,
      rows: 24,
      viewportY: 8,
      getScrollbackLength: () => 100,
      scrollToLine: () => {},
      renderer: {
        render: () => {},
      },
      wasmTerm: {},
      resize: (cols: number, rows: number) => { term.cols = cols; term.rows = rows; },
    };

    syncTerminalLayout({
      term,
      fitAddon: {
        proposeDimensions: () => ({ cols: 120, rows: 30 }),
        fit: () => { throw new Error("fit must not run before broker acknowledgement"); },
      },
      ptyClient: {
        supportsOrderedResize: true,
        sendResize: (cols: number, rows: number) => { sent.push({ cols, rows }); return Promise.resolve(); },
      },
      forceSend: true,
      repaint: true,
      onDimensionsChanged: () => { dimensionsChanged = true; },
    });

    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
    expect(term.cols).toBe(80);
    expect(dimensionsChanged).toBe(false);

    expect(commitTerminalResizePreservingScroll(term, { cols: 120, rows: 30 })).toBe(true);
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 120, rows: 30 });
  });

  test("keeps legacy peers functional without ordered resize capability", () => {
    const sent: Array<{ readonly cols: number; readonly rows: number }> = [];
    const term = {
      cols: 80,
      rows: 24,
      scrollToLine: () => {},
    };

    syncTerminalLayout({
      term,
      fitAddon: {
        proposeDimensions: () => ({ cols: 120, rows: 30 }),
        fit: () => { term.cols = 120; term.rows = 30; },
      },
      ptyClient: {
        supportsOrderedResize: false,
        sendResize: (cols: number, rows: number) => { sent.push({ cols, rows }); return Promise.resolve(); },
      },
      forceSend: false,
      repaint: false,
    });

    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 120, rows: 30 });
  });
});
