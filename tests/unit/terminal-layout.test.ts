import { describe, expect, test } from "bun:test";
import {
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

  test("sends a resize and requests full-prefill rehydration only after dimensions change", () => {
    const sent: Array<{ readonly force: boolean; readonly fit: boolean }> = [];
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
    };

    syncTerminalLayout({
      term,
      fitAddon: {
        fit: () => { term.cols = 120; },
      },
      ptyClient: {
        sendFitResize: (options: { readonly force: boolean; readonly fit: boolean }) => { sent.push(options); },
      },
      forceSend: true,
      repaint: true,
      onDimensionsChanged: () => { dimensionsChanged = true; },
    });

    expect(sent).toEqual([{ force: true, fit: false }]);
    expect(dimensionsChanged).toBe(true);
  });
});
