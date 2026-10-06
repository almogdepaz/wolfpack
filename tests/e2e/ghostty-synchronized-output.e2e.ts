import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface NativeCell {
  readonly codepoint: number;
  readonly width: number;
  readonly fg_r: number;
  readonly fg_g: number;
  readonly fg_b: number;
  readonly bg_r: number;
  readonly bg_g: number;
  readonly bg_b: number;
  readonly flags: number;
  readonly grapheme_len: number;
}
interface NativeSnapshotCell extends NativeCell { readonly text: string }
interface NativeSnapshot {
  readonly history: ReadonlyArray<ReadonlyArray<NativeSnapshotCell>>;
  readonly live: ReadonlyArray<ReadonlyArray<NativeSnapshotCell>>;
}
interface SyncTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly viewportY: number;
  readonly options: { fontSize: number };
  readonly wasmTerm: {
    getMode(mode: number): boolean;
    getViewport(): ReadonlyArray<NativeCell>;
    getScrollbackLine(offset: number): ReadonlyArray<NativeCell> | null;
    getGraphemeString(row: number, col: number): string;
    getScrollbackGraphemeString(offset: number, col: number): string;
  };
  readonly renderer: { render(buffer: object, force: boolean, offset: number, history: SyncTerminal): void };
  open(container: HTMLElement): void;
  write(bytes: string | Uint8Array): void;
  resize(cols: number, rows: number, options?: { readonly deferPresentation: boolean }): void;
  getScrollbackLength(): number;
  scrollToLine(line: number): void;
  clear(): void;
  dispose(): void;
}
interface SyncApi {
  init(): Promise<void>;
  readonly Ghostty: { load(): Promise<object> };
  readonly Terminal: new (options: { ghostty: object; cols: number; rows: number; scrollback: number; cursorBlink: boolean }) => SyncTerminal;
}
interface SyncFixture {
  readonly term: SyncTerminal;
  readonly api: SyncApi;
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly committed: string;
}
interface SyncWindow { readonly GhosttyWeb: SyncApi; syncFixture: SyncFixture }
interface ReferenceWindow extends SyncWindow {
  resizeReference: {
    readonly term: SyncTerminal;
    readonly canvas: HTMLCanvasElement;
    readonly container: HTMLElement;
    readonly snapshot: (term: SyncTerminal) => NativeSnapshot;
  };
}

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function openFixture(page: Page, format: "esm" | "umd"): Promise<void> {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/ghostty-web.bundle.js");
  await page.goto(server.baseUrl);
  expect(createHash("sha256").update(await (await response).body()).digest("hex"))
    .toBe(createHash("sha256").update(readFileSync(new URL("../../public/ghostty-web.bundle.js", import.meta.url))).digest("hex"));
  await page.waitForFunction(() => Boolean((window as unknown as SyncWindow).GhosttyWeb));
  if (format === "esm") {
    const body = readFileSync(new URL(import.meta.resolve("ghostty-web")));
    await page.route("**/__sync-renderer__.js", (route) => route.fulfill({ body, contentType: "application/javascript" }));
  }
  await page.evaluate(async (format) => {
    const moduleUrl = "/__sync-renderer__.js";
    const api: SyncApi = format === "esm" ? await import(moduleUrl) : (window as unknown as SyncWindow).GhosttyWeb;
    await api.init();
    const term = new api.Terminal({ ghostty: await api.Ghostty.load(), cols: 80, rows: 24, scrollback: 2000, cursorBlink: false });
    const container = document.createElement("div");
    document.body.append(container);
    term.open(container);
    term.write("\x1b[?25l\x1b[37m\x1b[HCOMMITTED 界 e\u0301");
    term.renderer.render(term.wasmTerm, true, term.viewportY, term);
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("native renderer canvas missing");
    (window as unknown as SyncWindow).syncFixture = { term, api, canvas, container, committed: canvas.toDataURL() };
  }, format);
}

async function seedResizeHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as SyncWindow).syncFixture;
    const { term, canvas } = fixture;
    const history = Array.from({ length: 200 }, (_, row) => `GREEN_HISTORY_${row}`).join("\r\n");
    const live = Array.from({ length: term.rows }, (_, row) => `LIVE_${row}_STABLE 界 e\u0301`).join("\r\n");
    term.write(`\x1b[32m${history}\r\n\x1b[37m${live}`);
    term.renderer.render(term.wasmTerm, true, term.viewportY, term);
    (window as unknown as SyncWindow).syncFixture = { ...fixture, committed: canvas.toDataURL() };
  });
}

async function openResizeReference(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { term: actual, api } = (window as unknown as SyncWindow).syncFixture;
    const term = new api.Terminal({ ghostty: await api.Ghostty.load(), cols: actual.cols, rows: actual.rows, scrollback: 2000, cursorBlink: false });
    const container = document.createElement("div");
    document.body.append(container);
    term.open(container);
    term.write("\x1b[?25l\x1b[37m\x1b[HCOMMITTED 界 e\u0301");
    term.renderer.render(term.wasmTerm, true, term.viewportY, term);
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("reference native canvas missing");
    // Both paths use real native state. Clone borrowed viewport cells before
    // reading history; no shared helper reimplements parsing or reflow.
    const snapshot = (terminal: SyncTerminal): NativeSnapshot => {
      const cells = terminal.wasmTerm.getViewport().map((cell) => ({ ...cell }));
      const live = Array.from({ length: terminal.rows }, (_, row) =>
        cells.slice(row * terminal.cols, (row + 1) * terminal.cols).map((cell, col) => ({
          ...cell, text: cell.width === 0 ? "" : cell.grapheme_len > 0
            ? terminal.wasmTerm.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32),
        })));
      const history = Array.from({ length: terminal.getScrollbackLength() }, (_, offset) => {
        const line = terminal.wasmTerm.getScrollbackLine(offset);
        if (!line) throw new Error(`native history line ${offset} missing`);
        return line.map((cell, col) => ({
          ...cell, text: cell.width === 0 ? "" : cell.grapheme_len > 0
            ? terminal.wasmTerm.getScrollbackGraphemeString(offset, col) : String.fromCodePoint(cell.codepoint || 32),
        }));
      });
      return { history, live };
    };
    (window as unknown as ReferenceWindow).resizeReference = { term, canvas, container, snapshot };
  });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    const reference = (window as unknown as ReferenceWindow).resizeReference;
    if (reference) { reference.term.dispose(); reference.container.remove(); }
    const fixture = (window as unknown as SyncWindow).syncFixture;
    if (fixture) { fixture.term.dispose(); fixture.container.remove(); }
  });
});

for (const format of ["esm", "umd"] as const) {
  test(`synchronized output holds real canvas across automatic and forced renders (${format})`, async ({ page }) => {
    await openFixture(page, format);
    const observation = await page.evaluate(async () => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.write("\x1b[?2026h\x1b[H\x1b[2K\x1b[32mINTERMEDIATE_GREEN");
      const active = term.wasmTerm.getMode(2026);
      const parsed = term.wasmTerm.getViewport().filter((cell) => cell.width !== 0)
        .map((cell) => String.fromCodePoint(cell.codepoint || 32)).join("");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      const forcedHeld = canvas.toDataURL() === committed;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const automaticHeld = canvas.toDataURL() === committed;
      term.write("\x1b[H\x1b[2K\x1b[37mCOMPLETE 界 e\u0301\x1b[?2026l");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      return { active, parsedPending: parsed.includes("INTERMEDIATE_GREEN"), forcedHeld, automaticHeld, committedAfterEnd: canvas.toDataURL() !== committed, ended: !term.wasmTerm.getMode(2026) };
    });
    expect(observation).toEqual({ active: true, parsedPending: true, forcedHeld: true, automaticHeld: true, committedAfterEnd: true, ended: true });
  });

  test(`resize and font changes preserve committed pixels until synchronization ends (${format})`, async ({ page }) => {
    await openFixture(page, format);
    const observation = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      const oldWidth = canvas.width;
      term.write("\x1b[?2026h\x1b[H\x1b[32mPENDING_RESIZE");
      term.resize(96, 30);
      const resizeHeld = canvas.toDataURL() === committed;
      term.options.fontSize = 18;
      const fontHeld = canvas.toDataURL() === committed;
      const logicalSize = [term.cols, term.rows];
      term.write("\x1b[H\x1b[2K\x1b[37mRESIZED_COMPLETE\x1b[?2026l");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      return { resizeHeld, fontHeld, logicalSize, widthUpdated: canvas.width > oldWidth, pixelsUpdated: canvas.toDataURL() !== committed };
    });
    expect(observation).toEqual({ resizeHeld: true, fontHeld: true, logicalSize: [96, 30], widthUpdated: true, pixelsUpdated: true });
  });

  test(`stalled synchronization recovers and the next transaction gets a fresh hold (${format})`, async ({ page }) => {
    await openFixture(page, format);
    await page.clock.install();
    const held = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.write("\x1b[?2026h\x1b[H\x1b[32mSTALLED");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      return canvas.toDataURL() === committed;
    });
    expect(held).toBe(true);
    await page.clock.fastForward(1200);
    const recovery = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      const watchdogReleased = canvas.toDataURL() !== committed;
      const previous = canvas.toDataURL();
      // End and begin in separate writes without an intervening render.
      term.write("\x1b[?2026l");
      term.write("\x1b[?2026h\x1b[H\x1b[31mSECOND_TRANSACTION");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      return { watchdogReleased, nextHeld: canvas.toDataURL() === previous };
    });
    expect(recovery).toEqual({ watchdogReleased: true, nextHeld: true });
  });

  test(`resize presentation retains pixels across reflow until visible output (${format})`, async ({ page }) => {
    await openFixture(page, format);
    await seedResizeHistory(page);
    const observation = await page.evaluate(async () => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      const totalRows = term.getScrollbackLength() + term.rows;
      term.resize(80, 40, { deferPresentation: true });
      const parsed = term.wasmTerm.getViewport().filter((cell) => cell.width !== 0)
        .map((cell) => String.fromCodePoint(cell.codepoint || 32)).join("");
      const retainedRows = term.getScrollbackLength() + term.rows;
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      const forcedHeld = canvas.toDataURL() === committed;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const automaticHeld = canvas.toDataURL() === committed;
      // A cursor query is input to the parser, not a new display frame.
      term.write("\x1b[6n");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      const queryHeld = canvas.toDataURL() === committed;
      term.write("\x1b[?2026h\x1b[H\x1b[32mINTERMEDIATE_GREEN");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      const transactionHeld = canvas.toDataURL() === committed;
      const live = Array.from({ length: term.rows }, (_, row) => `RESIZED_${row}_STABLE 界 e\u0301`).join("\r\n");
      term.write(`\x1b[H\x1b[2J\x1b[37m${live}\x1b[?2026l`);
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      return {
        logicalRows: term.rows, nativeHistoryExposed: parsed.includes("GREEN_HISTORY_"),
        historyPreserved: totalRows === retainedRows, forcedHeld, automaticHeld, queryHeld, transactionHeld,
        updated: canvas.toDataURL() !== committed,
      };
    });
    expect(observation).toEqual({ logicalRows: 40, nativeHistoryExposed: true, historyPreserved: true,
      forcedHeld: true, automaticHeld: true, queryHeld: true, transactionHeld: true, updated: true });
  });

  test(`resize presentation has a bounded deadline across repeated resizes (${format})`, async ({ page }) => {
    await openFixture(page, format);
    await seedResizeHistory(page);
    await page.clock.install();
    const initiallyHeld = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.resize(80, 30, { deferPresentation: true });
      return canvas.toDataURL() === committed;
    });
    expect(initiallyHeld).toBe(true);
    await page.clock.fastForward(900);
    await page.evaluate(() => (window as unknown as SyncWindow).syncFixture.term.resize(80, 40, { deferPresentation: true }));
    await page.clock.fastForward(200);
    const observation = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      const recovered = canvas.toDataURL() !== committed;
      const previous = canvas.toDataURL();
      term.resize(80, 45, { deferPresentation: true });
      const nextHeld = canvas.toDataURL() === previous;
      term.write("\x1b[H\x1b[2JUNSYNCHRONIZED_OUTPUT 界 e\u0301");
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      const outputReleased = canvas.toDataURL() !== previous;
      const beforeOrdinaryResize = canvas.toDataURL();
      term.resize(80, 46, { deferPresentation: true });
      term.resize(80, 48);
      return { recovered, nextHeld, outputReleased, ordinaryResizeImmediate: canvas.toDataURL() !== beforeOrdinaryResize };
    });
    expect(observation).toEqual({ recovered: true, nextHeld: true, outputReleased: true, ordinaryResizeImmediate: true });
  });

  test(`resize presentation yields to explicit clear and history navigation (${format})`, async ({ page }) => {
    await openFixture(page, format);
    await seedResizeHistory(page);
    const observation = await page.evaluate(() => {
      const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      term.resize(80, 40, { deferPresentation: true });
      const initiallyHeld = canvas.toDataURL() === committed;
      term.clear();
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      const clearParsed = term.wasmTerm.getViewport().every((cell) => cell.codepoint === 0 || cell.codepoint === 32);
      const clearPresented = canvas.toDataURL() !== committed;
      term.write("\x1b[HAFTER_CLEAR 界 e\u0301");
      term.renderer.render(term.wasmTerm, true, term.viewportY, term);
      const beforeHistory = canvas.toDataURL();
      term.resize(80, 45, { deferPresentation: true });
      term.scrollToLine(1);
      term.renderer.render(term.wasmTerm, false, term.viewportY, term);
      return { initiallyHeld, clearParsed, clearPresented, historyImmediate: canvas.toDataURL() !== beforeHistory && term.viewportY > 0 };
    });
    expect(observation).toEqual({ initiallyHeld: true, clearParsed: true, clearPresented: true, historyImmediate: true });
  });

  for (const synchronized of [true, false]) {
    test(`fragmented redraw preserves exact final native content and pixels (sync ${synchronized}, ${format})`, async ({ page }, testInfo) => {
      await openFixture(page, format);
      await openResizeReference(page);
      const observation = await page.evaluate(async (synchronized) => {
        const { term, canvas } = (window as unknown as SyncWindow).syncFixture;
        const reference = (window as unknown as ReferenceWindow).resizeReference;
        const history = Array.from({ length: 80 }, (_, row) => `H${row}|界|e\u0301`).join("\r\n");
        const live = Array.from({ length: term.rows }, (_, row) => `OLD${row}|界|e\u0301`).join("\r\n");
        for (const terminal of [term, reference.term]) {
          terminal.write(`\x1b[32m${history}\r\n\x1b[37m${live}`);
          terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal);
        }
        const committed = canvas.toDataURL();
        term.resize(80, 40, { deferPresentation: true });
        reference.term.resize(80, 40);
        const fragments = synchronized ? ["\x1b[?202", "6h"] : [];
        const modeObservations = [];
        for (const fragment of fragments) {
          term.write(fragment); reference.term.write(fragment);
          const immediateHeld = canvas.toDataURL() === committed;
          const mode = term.wasmTerm.getMode(2026);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          modeObservations.push({ fragment, mode, immediateHeld, afterFrameHeld: canvas.toDataURL() === committed });
        }
        const text = Array.from({ length: term.rows }, (_, row) => `NEW${row}|界|e\u0301|👩‍💻`).join("\r\n");
        const bytes = new TextEncoder().encode(`\x1b[H\x1b[2J\x1b[1;38;2;17;83;149m${text}`);
        const first = bytes.subarray(0, bytes.indexOf(10) + 1);
        term.write(first); reference.term.write(first);
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        const firstDirtyHeld = canvas.toDataURL() === committed;
        const modeAfterFirst = term.wasmTerm.getMode(2026);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const acrossFramesHeld = canvas.toDataURL() === committed;
        // Split inside UTF-8 and CSI sequences, not only at row boundaries.
        for (let offset = first.length; offset < bytes.length; offset += 7) {
          const chunk = bytes.subarray(offset, offset + 7);
          term.write(chunk); reference.term.write(chunk);
        }
        const beforeEndHeld = canvas.toDataURL() === committed;
        if (synchronized) { term.write("\x1b[?2026l"); reference.term.write("\x1b[?2026l"); }
        term.renderer.render(term.wasmTerm, false, term.viewportY, term);
        reference.term.renderer.render(reference.term.wasmTerm, true, reference.term.viewportY, reference.term);
        const state = reference.snapshot(term);
        const actualText = state.live.map((row) => row.filter((cell) => cell.width > 0).map((cell) => cell.text).join("").trimEnd()).join("\r\n");
        const styled = state.live[0].find((cell) => cell.codepoint === 78);
        return {
          firstDirtyHeld, acrossFramesHeld, beforeEndHeld,
          diagnostics: { modeObservations, modeAfterFirst, actualText, expectedText: text },
          nativeExact: JSON.stringify(state) === JSON.stringify(reference.snapshot(reference.term)),
          liveTextExact: actualText === text,
          trueColorExact: !!styled && styled.fg_r === 17 && styled.fg_g === 83 && styled.fg_b === 149,
          pixelsExact: canvas.toDataURL() === reference.canvas.toDataURL(),
        };
      }, synchronized);
      // Unsynchronized first-dirty release is an explicit characterization,
      // NOT a promise of atomic application-frame completion.
      await testInfo.attach("fragment-observations", { body: Buffer.from(JSON.stringify(observation.diagnostics, null, 2)), contentType: "application/json" });
      const { diagnostics, ...contract } = observation;
      expect(contract).toEqual({ firstDirtyHeld: synchronized, acrossFramesHeld: synchronized,
        beforeEndHeld: synchronized, nativeExact: true, liveTextExact: true, trueColorExact: true, pixelsExact: true });
    });
  }

  test(`resize reflow preserves exact history graphemes and attributes (${format})`, async ({ page }) => {
    await openFixture(page, format);
    await openResizeReference(page);
    const observations = await page.evaluate(() => {
      const { term, canvas } = (window as unknown as SyncWindow).syncFixture;
      const reference = (window as unknown as ReferenceWindow).resizeReference;
      const lines = Array.from({ length: 60 }, (_, row) => `H${row.toString().padStart(3, "0")}|界|e\u0301|👩‍💻|${"x".repeat(45)}`);
      const stream = `\x1b[H\x1b[2J\x1b[1;38;2;17;83;149;48;2;9;27;45m${lines.join("\r\n")}`;
      for (const terminal of [term, reference.term]) {
        terminal.write(stream);
        terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal);
      }
      const expectedText = lines.join("");
      const observations = [];
      for (const [cols, rows] of [[32, 16], [96, 40], [80, 24]]) {
        const committed = canvas.toDataURL();
        term.resize(cols, rows, { deferPresentation: true });
        reference.term.resize(cols, rows);
        const held = canvas.toDataURL() === committed;
        const state = reference.snapshot(term);
        const all = [...state.history, ...state.live].flat();
        const text = all.filter((cell) => cell.width > 0 && cell.text.trim() !== "").map((cell) => cell.text).join("");
        const content = all.filter((cell) => cell.codepoint > 32 && cell.width > 0);
        const attributesExact = content.every((cell) => cell.fg_r === 17 && cell.fg_g === 83 && cell.fg_b === 149
          && cell.bg_r === 9 && cell.bg_g === 27 && cell.bg_b === 45);
        const nativeExact = JSON.stringify(state) === JSON.stringify(reference.snapshot(reference.term));
        // History navigation cancels the hold without injecting a write that
        // would alter the content under preservation test.
        term.scrollToLine(1); reference.term.scrollToLine(1);
        term.renderer.render(term.wasmTerm, false, term.viewportY, term);
        reference.term.renderer.render(reference.term.wasmTerm, true, reference.term.viewportY, reference.term);
        observations.push({ cols, rows, held, nativeExact, textExact: text === expectedText, attributesExact,
          pixelsExact: canvas.toDataURL() === reference.canvas.toDataURL() });
        term.scrollToLine(0); reference.term.scrollToLine(0);
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        reference.term.renderer.render(reference.term.wasmTerm, true, reference.term.viewportY, reference.term);
      }
      return observations;
    });
    expect(observations).toEqual([[32, 16], [96, 40], [80, 24]].map(([cols, rows]) => ({
      cols, rows, held: true, nativeExact: true, textExact: true, attributesExact: true, pixelsExact: true,
    })));
  });

  for (const firstGate of ["sync", "resize"] as const) {
    test(`overlapping presentation deadlines preserve force intent (${firstGate} first, ${format})`, async ({ page }) => {
      await openFixture(page, format);
      await seedResizeHistory(page);
      await page.clock.install();
      await page.evaluate((firstGate) => {
        const { term } = (window as unknown as SyncWindow).syncFixture;
        if (firstGate === "sync") term.write("\x1b[?2026h");
        else term.resize(80, 30, { deferPresentation: true });
      }, firstGate);
      await page.clock.fastForward(600);
      await page.evaluate((firstGate) => {
        const { term } = (window as unknown as SyncWindow).syncFixture;
        if (firstGate === "sync") term.resize(80, 30, { deferPresentation: true });
        else term.write("\x1b[?2026h");
      }, firstGate);
      await page.clock.fastForward(500);
      const heldBySecondGate = await page.evaluate(() => {
        const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        return canvas.toDataURL() === committed;
      });
      expect(heldBySecondGate).toBe(true);
      await page.clock.fastForward(600);
      const recovery = await page.evaluate(() => {
        const { term, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
        term.renderer.render(term.wasmTerm, false, term.viewportY, term);
        const timeoutRecovered = canvas.toDataURL() !== committed;
        term.write("\x1b[?2026l");
        const previous = canvas.toDataURL();
        term.resize(80, 40, { deferPresentation: true });
        term.write("\x1b[?2026h\x1b[HNEW_PENDING");
        term.scrollToLine(1);
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        const historyRequested = term.viewportY > 0;
        const historyCannotBypassSync = canvas.toDataURL() === previous;
        term.write("\x1b[H\x1b[2JCOMPLETE\x1b[?2026l");
        term.renderer.render(term.wasmTerm, false, term.viewportY, term);
        return { timeoutRecovered, historyRequested, historyCannotBypassSync, finalReleased: canvas.toDataURL() !== previous };
      });
      expect(recovery).toEqual({ timeoutRecovered: true, historyRequested: true, historyCannotBypassSync: true, finalReleased: true });
    });
  }

  test(`holding or disposing one terminal does not block another isolated terminal (${format})`, async ({ page }) => {
    await openFixture(page, format);
    const observation = await page.evaluate(async () => {
      const { term, api, canvas, committed } = (window as unknown as SyncWindow).syncFixture;
      const other = new api.Terminal({ ghostty: await api.Ghostty.load(), cols: 32, rows: 8, scrollback: 2000, cursorBlink: false });
      const container = document.createElement("div");
      document.body.append(container);
      try {
        other.open(container);
        const otherCanvas = container.querySelector("canvas");
        if (!otherCanvas) throw new Error("second native canvas missing");
        const blank = otherCanvas.toDataURL();
        term.write("\x1b[?2026hPENDING");
        term.resize(90, 30, { deferPresentation: true });
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        other.write("\x1b[?25lINDEPENDENT 界 e\u0301");
        other.renderer.render(other.wasmTerm, true, other.viewportY, other);
        const independentPixels = otherCanvas.toDataURL();
        const held = canvas.toDataURL() === committed;
        term.dispose();
        other.write("\x1b[HFOLLOWUP");
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return { held, otherUpdated: independentPixels !== blank, otherSurvived: otherCanvas.toDataURL() !== independentPixels };
      } finally { other.dispose(); container.remove(); }
    });
    expect(observation).toEqual({ held: true, otherUpdated: true, otherSurvived: true });
  });
}
