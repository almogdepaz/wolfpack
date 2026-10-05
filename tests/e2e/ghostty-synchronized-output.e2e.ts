import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface SyncTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly viewportY: number;
  readonly options: { fontSize: number };
  readonly wasmTerm: {
    getMode(mode: number): boolean;
    getViewport(): ReadonlyArray<{ readonly codepoint: number; readonly width: number }>;
  };
  readonly renderer: { render(buffer: object, force: boolean, offset: number, history: SyncTerminal): void };
  open(container: HTMLElement): void;
  write(bytes: string): void;
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

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
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
