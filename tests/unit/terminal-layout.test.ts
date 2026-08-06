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

  test("does not commit proposed columns until the broker resize acknowledgement", () => {
    const sent: Array<{ readonly cols: number; readonly rows: number }> = [];
    let dimensionsChanged = false;
    const term = {
      cols: 80,
      rows: 24,
      viewportY: 8,
      getScrollbackLength: () => 100,
      scrollToLine: () => {},
      resize: (cols: number, rows: number) => { term.cols = cols; term.rows = rows; },
      renderer: { render: () => {} },
      wasmTerm: {},
    };

    syncTerminalLayout({
      term,
      fitAddon: {
        proposeDimensions: () => ({ cols: 120, rows: 30 }),
        fit: () => { throw new Error("fit must not run before broker acknowledgement"); },
      },
      ptyClient: {
        sendResize: (cols: number, rows: number) => { sent.push({ cols, rows }); },
      },
      forceSend: true,
      repaint: true,
      onDimensionsChanged: () => { dimensionsChanged = true; },
    });

    // Representative ANSI output arriving during the resize race is still
    // interpreted at the broker's currently committed 80-column geometry.
    const ansiRenderWidthDuringRace = term.cols;
    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
    expect(ansiRenderWidthDuringRace).toBe(80);
    expect(dimensionsChanged).toBe(false);

    expect(commitTerminalResizePreservingScroll(term, { cols: 120, rows: 30 })).toBe(true);
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 120, rows: 30 });
  });
});
