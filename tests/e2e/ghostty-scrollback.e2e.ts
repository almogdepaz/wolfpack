import { expect, test } from "@playwright/test";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

let server: TestServer;

interface BrowserTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly renderer: {
    getDevicePixelRatio(): number;
  };
  open(element: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  readonly wasmTerm: {
    update(): void;
    getScrollbackLength(): number;
  };
}

interface GhosttyWebApi {
  init(): Promise<void>;
  readonly Terminal: new (options: {
    readonly cols: number;
    readonly rows: number;
    readonly scrollback: number;
    readonly cursorBlink: boolean;
  }) => BrowserTerminal;
}

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test("retains append-only scrollback below its configured line limit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "browser terminal regression test");

  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean(
    (window as unknown as { readonly GhosttyWeb?: unknown }).GhosttyWeb,
  ));

  const scrollbackLengths = await page.evaluate(async () => {
    const ghosttyWeb = (window as unknown as { readonly GhosttyWeb: GhosttyWebApi }).GhosttyWeb;
    await ghosttyWeb.init();

    const term = new ghosttyWeb.Terminal({
      cols: 130,
      rows: 39,
      scrollback: 10_000,
      cursorBlink: false,
    });
    const container = document.createElement("div");
    document.body.append(container);
    term.open(container);

    try {
      const scrollbackLengths: number[] = [];
      for (let batch = 1; batch <= 14; batch++) {
        const lines: string[] = [];
        for (let line = 1; line <= 68; line++) {
          lines.push(
            `\x1b[1;3;38;5;${(batch * 17 + line) % 256}m`
            + `batch=${String(batch).padStart(2, "0")} line=${String(line).padStart(3, "0")} `
            + `${"#".repeat(52)}\x1b[0m`,
          );
        }
        term.write(lines.join("\r\n"));
        term.wasmTerm.update();
        scrollbackLengths.push(term.wasmTerm.getScrollbackLength());
      }
      return scrollbackLengths;
    } finally {
      term.dispose();
      container.remove();
    }
  });

  for (let index = 1; index < scrollbackLengths.length; index++) {
    const previous = scrollbackLengths[index - 1];
    const current = scrollbackLengths[index];
    expect(current, `scrollback dropped after batch ${index + 1}`).toBeGreaterThanOrEqual(previous!);
  }
  expect(scrollbackLengths.at(-1)).toBeGreaterThanOrEqual(14 * 68 - 39);
});

test("updates canvas renderer dpr after a browser scale change", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "browser terminal regression test");

  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean(
    (window as unknown as { readonly GhosttyWeb?: unknown }).GhosttyWeb,
  ));

  const observed = await page.evaluate(async () => {
    const ghosttyWeb = (window as unknown as { readonly GhosttyWeb: GhosttyWebApi }).GhosttyWeb;
    const originalMatchMedia = window.matchMedia;
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    let devicePixelRatio = 1;
    const listeners: Array<() => void> = [];

    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      get: () => devicePixelRatio,
    });
    window.matchMedia = ((media: string) => ({
      media,
      addEventListener(type: string, callback: () => void): void {
        if (type === "change") listeners.push(callback);
      },
      removeEventListener(type: string, callback: () => void): void {
        if (type !== "change") return;
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      },
    })) as typeof window.matchMedia;

    await ghosttyWeb.init();
    const term = new ghosttyWeb.Terminal({
      cols: 80,
      rows: 24,
      scrollback: 100,
      cursorBlink: false,
    });
    const container = document.createElement("div");
    document.body.append(container);
    term.open(container);

    try {
      const initialDpr = term.renderer.getDevicePixelRatio();
      devicePixelRatio = 2;
      for (const listener of [...listeners]) listener();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { initialDpr, updatedDpr: term.renderer.getDevicePixelRatio() };
    } finally {
      term.dispose();
      container.remove();
      window.matchMedia = originalMatchMedia;
      if (originalDpr) Object.defineProperty(window, "devicePixelRatio", originalDpr);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  expect(observed.initialDpr).toBe(1);
  expect(observed.updatedDpr).toBe(2);
});
