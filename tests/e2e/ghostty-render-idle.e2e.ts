import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface RenderCounts {
  readonly text: number;
  readonly rects: number;
  readonly lines: number;
  readonly fonts: number;
  readonly duplicateStyles: number;
}
interface IdleTerminal {
  readonly options: { cursorStyle: "bar" | "block" | "underline"; fontFamily: string };
  readonly viewportY: number;
  readonly wasmTerm: {
    write(text: string): void;
    getViewport(): ReadonlyArray<{ readonly hyperlink_id: number }>;
  };
  readonly renderer: {
    cursorVisible: boolean;
    readonly ctx: CanvasRenderingContext2D;
    render(buffer: object, forceAll: boolean, viewportY: number, history: IdleTerminal): void;
    renderLine(cells: object, row: number, cols: number): void;
    setHoveredHyperlinkId(id: number): void;
    setHoveredLinkRange(range: { startX: number; startY: number; endX: number; endY: number } | null): void;
  };
  open(container: HTMLElement): void;
  write(text: string): void;
  scrollToLine(offset: number): void;
  select(column: number, row: number, length: number): void;
  clearSelection(): void;
  dispose(): void;
}
interface IdleApi {
  init(): Promise<void>;
  readonly Ghostty: { load(): Promise<object> };
  readonly Terminal: new (options: {
    ghostty: object; cols: number; rows: number; scrollback: number; cursorBlink: boolean;
  }) => IdleTerminal;
}
interface IdleFixture {
  readonly term: IdleTerminal;
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  render(force?: boolean): void;
  measure(action: () => void): RenderCounts;
}
interface IdleWindow {
  readonly GhosttyWeb: IdleApi;
  idleFixture: IdleFixture;
}

// Captured BEFORE renderer edits from HEAD 4ec4ae08's served bundle (sha256
// 8969ec73ba02d58d7319bb516ea470a7cd44d035fc08e68a36d1a975c6c66742),
// with this test's pixel sequence, desktop Chromium 1243, 80x24 monospace.
// browser.version()/process.platform below identify that capture environment.
// The independent native-canvas font probe was captured with the retained
// PRE-CHANGE bundle, not recalibrated from candidate terminal pixels. It also
// rejects changed host/fallback fonts on the same OS and browser version.
const BASELINE_ENVIRONMENT = {
  browserName: "chromium",
  browserVersion: "153.0.8010.12",
  platform: "linux",
  devicePixelRatio: 1,
  fontFamily: "monospace",
  fontRasterHash: "ca5e18f9a3753551d804a8994bd32683aa6c88e5c6d812027c8f9a13dd6c9929",
} as const;
// Hashes cover canvas.toDataURL(), not a reimplementation of the renderer.
const BASELINE_PIXELS: readonly string[] = [
  "1da26e858dafeb38202c8330ced2835ddc0aada252f45706feb75315b569d4c7",
  "8f7bc5c3bcc0ce8292a9310276824beec31e300e5531f3364eb53be07b9f34c0",
  "43ffc32770dfc184a05c7108156ad4a0f138a7719b9e6d5387bb49681b4407a1",
  "42ad2507bd03fec912bd87d24d94f5504e1248f85c84a59866d9fba3d9206936",
  "1496a796b9c285477b7ee42b51fdbd4bdd447014b9e9a59d6d335736d32df6e3",
  "9d1d8642f5fdec6b7dc754ce0538a5cdce74b33ebc76e9dc5918338bfc376d72",
  "1496a796b9c285477b7ee42b51fdbd4bdd447014b9e9a59d6d335736d32df6e3",
  "470ac741fb529e5e5579e176fbf8fc5186497172ddbd0c6ca36d35a1d6174476",
  "1e233563729aaad049196b34ecfc44a6c7bbb58d6467589086da7ae5bf0534cc",
  "c07a44c78d0fff98fdfc36254b1e211e60b94ef5e34eb473f8a30437a8a96be0",
];

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "real desktop canvas/WASM regression");
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as unknown as IdleWindow).idleFixture;
    if (fixture) { fixture.term.dispose(); fixture.container.remove(); }
  });
});

async function openFixture(page: Page, format: "esm" | "umd", blink = false): Promise<void> {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/ghostty-web.bundle.js");
  await page.goto(server.baseUrl);
  expect(createHash("sha256").update(await (await response).body()).digest("hex"))
    .toBe(createHash("sha256").update(readFileSync(new URL("../../public/ghostty-web.bundle.js", import.meta.url))).digest("hex"));
  await page.waitForFunction(() => Boolean((window as unknown as IdleWindow).GhosttyWeb));
  if (format === "esm") {
    const body = readFileSync(new URL(import.meta.resolve("ghostty-web")));
    await page.route("**/__idle-renderer__.js", (route) => route.fulfill({ body, contentType: "application/javascript" }));
  }
  await page.evaluate(async ({ format, blink }) => {
    const moduleUrl = "/__idle-renderer__.js";
    const api: IdleApi = format === "esm" ? await import(moduleUrl) : (window as unknown as IdleWindow).GhosttyWeb;
    await api.init();
    await document.fonts.ready;
    const term = new api.Terminal({ ghostty: await api.Ghostty.load(), cols: 80, rows: 24, scrollback: 2000, cursorBlink: blink });
    const container = document.createElement("div");
    document.body.append(container);
    term.open(container);
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("real renderer canvas missing");
    const render = (force = false): void => term.renderer.render(term.wasmTerm, force, term.viewportY, term);
    const measure = (action: () => void): RenderCounts => {
      const prototype = CanvasRenderingContext2D.prototype;
      const originalText = prototype.fillText;
      const originalRect = prototype.fillRect;
      const originalLine = term.renderer.renderLine;
      const font = Object.getOwnPropertyDescriptor(prototype, "font");
      const fill = Object.getOwnPropertyDescriptor(prototype, "fillStyle");
      if (!font?.get || !font.set || !fill?.get || !fill.set) throw new Error("native canvas style accessors missing");
      const counts = { text: 0, rects: 0, lines: 0, fonts: 0, duplicateStyles: 0 };
      let previousStyle: unknown;
      prototype.fillText = function (...args: Parameters<CanvasRenderingContext2D["fillText"]>): void {
        if (this === term.renderer.ctx) counts.text++;
        originalText.apply(this, args);
      };
      prototype.fillRect = function (...args: Parameters<CanvasRenderingContext2D["fillRect"]>): void {
        if (this === term.renderer.ctx) counts.rects++;
        originalRect.apply(this, args);
      };
      term.renderer.renderLine = function (...args: Parameters<IdleTerminal["renderer"]["renderLine"]>): void {
        counts.lines++;
        originalLine.apply(this, args);
      };
      Object.defineProperty(prototype, "font", { ...font, set(this: CanvasRenderingContext2D, value: string): void {
        if (this === term.renderer.ctx) counts.fonts++;
        font.set?.call(this, value);
      } });
      Object.defineProperty(prototype, "fillStyle", { ...fill, set(this: CanvasRenderingContext2D, value: string | CanvasGradient | CanvasPattern): void {
        if (this === term.renderer.ctx) {
          if (previousStyle === value) counts.duplicateStyles++;
          previousStyle = value;
        }
        fill.set?.call(this, value);
      } });
      try { action(); return counts; }
      finally {
        prototype.fillText = originalText;
        prototype.fillRect = originalRect;
        term.renderer.renderLine = originalLine;
        Object.defineProperty(prototype, "font", font);
        Object.defineProperty(prototype, "fillStyle", fill);
      }
    };
    (window as unknown as IdleWindow).idleFixture = { term, canvas, container, render, measure };
  }, { format, blink });
}

for (const format of ["esm", "umd"] as const) {
  test(`unchanged scrolled selection is idle and viewport changes repaint (${format})`, async ({ page }) => {
    await openFixture(page, format, true);
    const counts = await page.evaluate(() => {
      const { term, render, measure } = (window as unknown as IdleWindow).idleFixture;
      term.write(Array.from({ length: 200 }, (_, row) => `history ${row}: a   b`).join("\r\n"));
      term.scrollToLine(40);
      term.select(0, 2, 8);
      render();
      const idle = measure(() => { for (let frame = 0; frame < 10; frame++) render(); });
      const scroll = measure(() => { term.scrollToLine(41); render(); });
      return { idle, scroll };
    });
    expect(counts.idle.text).toBe(0);
    expect(counts.idle.rects).toBe(0);
    expect(counts.scroll.text).toBeGreaterThan(0);
    expect(counts.scroll.rects).toBeGreaterThan(0);
  });

  test(`cursor row repaints only on blink transitions or movement (${format})`, async ({ page }) => {
    await openFixture(page, format, true);
    const counts = await page.evaluate(() => {
      const { term, render, measure } = (window as unknown as IdleWindow).idleFixture;
      term.write("cursor row\x1b[2;1Hsecond row");
      render();
      const idle = measure(() => { for (let frame = 0; frame < 10; frame++) render(); });
      // Same toggle used by startCursorBlink's 530ms interval, synchronously
      // so neither RAF scheduling nor wall-clock sleeps weaken the assertion.
      const hide = measure(() => { term.renderer.cursorVisible = !term.renderer.cursorVisible; render(); });
      const hiddenIdle = measure(() => { for (let frame = 0; frame < 10; frame++) render(); });
      const show = measure(() => { term.renderer.cursorVisible = !term.renderer.cursorVisible; render(); });
      const move = measure(() => { term.write("\x1b[3;4H"); render(); });
      return { idle, hide, hiddenIdle, show, move };
    });
    expect(counts.idle.text).toBe(0);
    expect(counts.idle.rects).toBe(0);
    expect(counts.hide.lines).toBe(1);
    expect(counts.hiddenIdle.text).toBe(0);
    expect(counts.show.lines).toBe(1);
    expect(counts.move.lines).toBeGreaterThan(0);
  });

  test(`runtime cursor appearance repaints a stationary non-blinking cursor (${format})`, async ({ page }) => {
    await openFixture(page, format, false);
    const observation = await page.evaluate(() => {
      const { term, canvas, render, measure } = (window as unknown as IdleWindow).idleFixture;
      term.write("stationary cursor");
      term.options.cursorStyle = "bar";
      render(true);
      const before = canvas.toDataURL();
      term.options.cursorStyle = "block";
      const counts = measure(() => render());
      const incremental = canvas.toDataURL();
      render(true);
      return { counts, changed: incremental !== before, pixelsEqual: incremental === canvas.toDataURL() };
    });
    expect(observation.counts.lines).toBe(1);
    expect(observation.counts.text).toBeGreaterThan(0);
    expect(observation.counts.rects).toBeGreaterThan(0);
    expect(observation.changed).toBe(true);
    expect(observation.pixelsEqual).toBe(true);
  });

  test(`blank glyphs are skipped and canvas state is reused within the pass (${format})`, async ({ page }) => {
    await openFixture(page, format);
    const counts = await page.evaluate(() => {
      const { term, render, measure } = (window as unknown as IdleWindow).idleFixture;
      term.write("\x1b[?25la   b");
      return measure(() => render(true));
    });
    expect(counts.text).toBe(2);
    expect(counts.fonts).toBe(1);
    expect(counts.duplicateStyles).toBe(0);
  });

  for (const fontFamily of ["monospace", "Liberation Mono"] as const) test(`forced and incremental pixels retain the pre-change canvas sequence (${format}, ${fontFamily})`, async ({ page, browser }, testInfo) => {
    await openFixture(page, format);
    const observation = await page.evaluate((fontFamily) => {
      const { term, canvas, render } = (window as unknown as IdleWindow).idleFixture;
      term.options.fontFamily = fontFamily;
      const frames: Array<{ phase: string; full: string; incremental: string }> = [];
      const capture = (phase: string): void => {
        render();
        const incremental = canvas.toDataURL();
        render(true);
        frames.push({ phase, incremental, full: canvas.toDataURL() });
      };
      const lines = Array.from({ length: 200 }, (_, row) =>
        `\x1b[38;2;17;83;149;48;2;9;27;45mrow ${row}: 界 e\u0301 \x1b[1;3;4;9mstyle   \x1b[0m`);
      term.write("\x1b[?25l" + lines.join("\r\n"));
      capture("styled live");
      term.select(2, 2, 12);
      capture("live selection");
      term.scrollToLine(10);
      capture("mixed history selection");
      term.scrollToLine(40);
      term.select(3, 3, 10);
      capture("history selection");
      term.clearSelection();
      capture("clear selection");
      term.renderer.setHoveredLinkRange({ startX: 0, startY: 1, endX: 10, endY: 1 });
      capture("history link hover");
      term.renderer.setHoveredLinkRange(null);
      capture("clear hover");
      // Native writes bypass Terminal.write's intentional auto-scroll-to-bottom,
      // matching the real scroll-lock integration without faking dirty state.
      term.wasmTerm.write("\r\nnew output while scrolled");
      capture("dirty history growth");
      term.scrollToLine(0);
      term.write("\x1b[H\x1b[2K\x1b]8;;https://example.invalid\x1b\\linked\x1b]8;;\x1b\\");
      const id = term.wasmTerm.getViewport()[0]?.hyperlink_id;
      if (!id) throw new Error("native OSC8 hyperlink missing");
      term.renderer.setHoveredHyperlinkId(id);
      capture("live osc8 hover");
      term.renderer.setHoveredHyperlinkId(0);
      capture("clear osc8 hover");
      // Probe native rasterization independently of ghostty's render paths.
      // Cover every font style and the Latin/wide/combining glyphs in the fixture.
      const nativeRaster = (family: string): string => {
        const probe = document.createElement("canvas");
        probe.width = 1024;
        probe.height = 120;
        const ctx = probe.getContext("2d");
        if (!ctx) throw new Error("native font probe context missing");
        ctx.fillStyle = "rgb(9, 27, 45)";
        ctx.fillRect(0, 0, probe.width, probe.height);
        for (const [index, style] of ["", "bold ", "italic ", "italic bold "].entries()) {
          ctx.font = `${style}15px ${family}`;
          ctx.fillStyle = "rgb(17, 83, 149)";
          ctx.fillText("row 199: 界 e\u0301 style linked new output while scrolled", 4, 24 + index * 24);
        }
        return probe.toDataURL();
      };
      return { frames, fontRaster: nativeRaster(fontFamily), defaultFontRaster: nativeRaster("monospace"), devicePixelRatio: window.devicePixelRatio };
    }, fontFamily);
    const { frames } = observation;
    const hashes = frames.map((frame) => createHash("sha256").update(frame.full).digest("hex"));
    const frameHashes = frames.map((frame, index) => ({
      phase: frame.phase,
      full: hashes[index],
      incremental: createHash("sha256").update(frame.incremental).digest("hex"),
    }));
    const defaultFontRasterHash = createHash("sha256").update(observation.defaultFontRaster).digest("hex");
    const environment = {
      browserName: browser.browserType().name(),
      browserVersion: browser.version(),
      platform: process.platform,
      devicePixelRatio: observation.devicePixelRatio,
      fontFamily,
      fontRasterHash: createHash("sha256").update(observation.fontRaster).digest("hex"),
    };
    const fixtureMatches = environment.browserName === BASELINE_ENVIRONMENT.browserName
      && environment.browserVersion === BASELINE_ENVIRONMENT.browserVersion
      && environment.platform === BASELINE_ENVIRONMENT.platform
      && environment.devicePixelRatio === BASELINE_ENVIRONMENT.devicePixelRatio
      && environment.fontFamily === BASELINE_ENVIRONMENT.fontFamily
      && environment.fontRasterHash === BASELINE_ENVIRONMENT.fontRasterHash;
    console.log(`pixel-fixture ${format}/${fontFamily}: ${JSON.stringify({ environment, defaultFontRasterHash, fixtureMatches, hashes, frameHashes })}`);
    await testInfo.attach("pixel-hashes", {
      body: Buffer.from(JSON.stringify({ environment, defaultFontRasterHash, fixtureMatches, hashes, frameHashes })),
      contentType: "application/json",
    });
    if (fontFamily === "monospace") {
      // Unconditional for the default font, including other browsers/OSes.
      for (const frame of frames) expect(frame.incremental, frame.phase).toBe(frame.full);
    } else {
      // Liberation Mono incremental/full inequality at "live selection" also
      // reproduces on main 4ec4ae08 and is tracked separately. This case only
      // exercises fixture-key mismatch; do not rebaseline or fix the renderer.

      expect(environment.fontRasterHash, "installed alternate monospace font must rasterize differently from the actual default").not.toBe(defaultFontRasterHash);
      expect(fixtureMatches, "real alternate rasterizer exercises the mismatch path").toBe(false);
    }
    if (fixtureMatches) {
      expect(hashes).toEqual(BASELINE_PIXELS);
    } else {
      testInfo.annotations.push({
        type: "baseline-fixture-skipped",
        description: `stored pre-change hashes require ${JSON.stringify(BASELINE_ENVIRONMENT)}; observed ${JSON.stringify(environment)}. ${fontFamily === "monospace" ? "incremental/full equality still checked." : "Liberation Mono exercises fixture-key mismatch only; main's incremental/full discrepancy is tracked separately."}`,
      });
    }
  });
}
