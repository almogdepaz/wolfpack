import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface GhosttyCell {
  readonly hyperlink_id: number;
}

interface BrowserTerminal {
  readonly viewportY: number;
  readonly wasmTerm: {
    getViewport(update?: boolean): readonly GhosttyCell[];
  };
  readonly renderer: {
    render(buffer: object, forceAll: boolean, viewportY: number, scrollback: BrowserTerminal): void;
    setHoveredHyperlinkId(id: number): void;
    setHoveredLinkRange(range: { startX: number; startY: number; endX: number; endY: number } | null): void;
  };
  open(element: HTMLElement): void;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  scrollToLine(offset: number): void;
  select(column: number, row: number, length: number): void;
  clearSelection(): void;
  dispose(): void;
}

interface GhosttyWebApi {
  init(): Promise<void>;
  readonly Ghostty: { load(): Promise<object> };
  readonly Terminal: new (options: {
    readonly ghostty: object;
    readonly cols: number;
    readonly rows: number;
    readonly scrollback: number;
    readonly cursorBlink: boolean;
  }) => BrowserTerminal;
}

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

for (const [format, rows] of [["umd", 24], ["umd", 70], ["esm", 24], ["esm", 70]] as const) {
  test(`batches viewport reads without changing real rendered pixels at ${rows} rows (${format})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "real desktop canvas/WASM regression");
    const [assetResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/ghostty-web.bundle.js"),
      page.goto(server.baseUrl),
    ]);
    const servedHash = createHash("sha256").update(await assetResponse.body()).digest("hex");
    const builtHash = createHash("sha256")
      .update(readFileSync(new URL("../../public/ghostty-web.bundle.js", import.meta.url))).digest("hex");
    expect(servedHash, "served renderer matches the built asset").toBe(builtHash);
    await testInfo.attach("served-ghostty-sha256", { body: Buffer.from(servedHash), contentType: "text/plain" });
    await page.waitForFunction(() => Boolean(
      (window as unknown as { readonly GhosttyWeb?: unknown }).GhosttyWeb,
    ));

    if (format === "esm") {
      const module = readFileSync(new URL(import.meta.resolve("ghostty-web")));
      await page.route("**/__renderer-test__.js", (route) => route.fulfill({
        body: module,
        contentType: "application/javascript",
      }));
    }
    const frames = await page.evaluate(async ({ rows, format }) => {
      const moduleUrl = "/__renderer-test__.js";
      const api: GhosttyWebApi = format === "esm"
        ? await import(moduleUrl)
        : (window as unknown as { readonly GhosttyWeb: GhosttyWebApi }).GhosttyWeb;
      await api.init();
      const terminal = new api.Terminal({
        ghostty: await api.Ghostty.load(),
        cols: 80,
        rows,
        scrollback: 2000,
        cursorBlink: false,
      });
      const container = document.createElement("div");
      document.body.append(container);
      terminal.open(container);
      const getViewport = terminal.wasmTerm.getViewport.bind(terminal.wasmTerm);
      let viewportReads = 0;
      terminal.wasmTerm.getViewport = (update?: boolean): readonly GhosttyCell[] => {
        viewportReads++;
        return getViewport(update);
      };
      // A row-only view of the SAME native terminal is the reference path.
      // All methods call through; no fake cells or second renderer implementation.
      const rowOnly = new Proxy(terminal.wasmTerm, {
        get(target, property, receiver): unknown {
          if (property === "getViewport") return undefined;
          const member: unknown = Reflect.get(target, property, receiver);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const frames: Array<{
        readonly phase: string;
        readonly viewportReads: number;
        readonly pixelsMatchRowReference: boolean;
        readonly changedFromPreviousFrame: boolean;
        readonly expectedReads: number;
        readonly expectedChange: boolean;
      }> = [];
      let previousPixels: string | undefined;
      function capture(phase: string, forceAll = true, expectedReads = 1, expectedChange = true): void {
        const canvas = container.querySelector("canvas");
        if (!canvas) throw new Error("real renderer did not create its canvas");
        viewportReads = 0;
        terminal.renderer.render(terminal.wasmTerm, forceAll, terminal.viewportY, terminal);
        const actualReads = viewportReads;
        const actualPixels = canvas.toDataURL();
        terminal.renderer.render(rowOnly, true, terminal.viewportY, terminal);
        const referencePixels = canvas.toDataURL();
        frames.push({
          phase,
          viewportReads: actualReads,
          pixelsMatchRowReference: actualPixels === referencePixels,
          changedFromPreviousFrame: previousPixels !== actualPixels,
          expectedReads,
          expectedChange,
        });
        previousPixels = actualPixels;
      }

      try {
        const lines = Array.from({ length: rows }, (_, index) =>
          `\x1b[38;5;${16 + index}mrow ${index}: 界 e\u0301 \x1b[1;4mstyled\x1b[0m`);
        terminal.write("\x1b[2J\x1b[H" + lines.join("\r\n"));
        capture("styled full viewport");
        terminal.write("\x1b[2;1H\x1b[2Kchanged row: 界 e\u0301");
        capture("later write invalidates frame snapshot");
        capture("clean frame does not materialize viewport", false, 0, false);
        terminal.write("\x1b[4;1Hdirty row");
        capture("dirty-row repaint", false);
        terminal.write("\x1b[6;10H");
        capture("cursor-only movement", false);
        terminal.select(0, 0, 8);
        capture("selection", false);
        terminal.clearSelection();
        capture("clear selection", false);
        terminal.write("\x1b[H\x1b[2K\x1b]8;;https://example.invalid\x1b\\linked\x1b]8;;\x1b\\");
        capture("osc8 text", false);
        const linkId = terminal.wasmTerm.getViewport()[0]?.hyperlink_id;
        if (!linkId) throw new Error("native OSC8 fixture has no hyperlink id");
        terminal.renderer.setHoveredHyperlinkId(linkId);
        capture("osc8 hover", false);
        terminal.renderer.setHoveredHyperlinkId(0);
        capture("clear osc8 hover", false);
        terminal.renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 5, endY: 0 });
        capture("regex link hover", false);
        terminal.renderer.setHoveredLinkRange(null);
        capture("clear regex link hover", false);
        terminal.write("\x1b[?1049h\x1b[Halternate screen");
        capture("alternate buffer");
        terminal.write("\x1b[?1049l");
        capture("restore normal buffer");
        terminal.resize(96, rows + 3);
        capture("resize");
        terminal.write("\x1b[H" + Array.from({ length: rows * 4 }, (_, index) => `history ${index}`).join("\r\n"));
        terminal.scrollToLine(3);
        capture("mixed scrollback and viewport");
        terminal.scrollToLine(rows + 3);
        capture("history-only frame", true, 0);
        terminal.scrollToLine(0);
        terminal.write("\x1b[?25l");
        capture("return to live viewport");
        const other = new api.Terminal({
          ghostty: await api.Ghostty.load(), cols: 32, rows: 8, scrollback: 2000, cursorBlink: false,
        });
        const otherContainer = document.createElement("div");
        document.body.append(otherContainer);
        try {
          other.open(otherContainer);
          other.write("different terminal: 界 e\u0301");
          other.renderer.render(other.wasmTerm, true, other.viewportY, other);
          capture("another isolated terminal cannot replace this frame", true, 1, false);
        } finally {
          other.dispose();
          otherContainer.remove();
        }
        return frames;
      } finally {
        terminal.dispose();
        container.remove();
      }
    }, { rows, format });

    await testInfo.attach("viewport-frames", {
      body: Buffer.from(JSON.stringify(frames)),
      contentType: "application/json",
    });
    expect(frames).toHaveLength(19);
    for (const frame of frames) {
      expect(frame.pixelsMatchRowReference, frame.phase).toBe(true);
      expect(frame.changedFromPreviousFrame, frame.phase).toBe(frame.expectedChange);
      expect(frame.viewportReads, `${frame.phase}: full viewport reads per frame`).toBe(frame.expectedReads);
    }
  });
}
