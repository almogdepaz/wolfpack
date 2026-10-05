import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

interface ListenerTerminal {
  open(container: HTMLElement): void;
  write(bytes: string): void;
  dispose(): void;
}

interface ListenerApi {
  init(): Promise<void>;
  readonly Ghostty: { load(): Promise<object> };
  readonly Terminal: new (options: {
    readonly ghostty: object;
    readonly cols: number;
    readonly rows: number;
    readonly scrollback: number;
    readonly cursorBlink: boolean;
  }) => ListenerTerminal;
}

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function loadRenderer(page: Page, format: "esm" | "umd"): Promise<void> {
  const served = page.waitForResponse((response) => new URL(response.url()).pathname === "/ghostty-web.bundle.js");
  await page.goto(server.baseUrl);
  expect(createHash("sha256").update(await (await served).body()).digest("hex"))
    .toBe(createHash("sha256").update(readFileSync(new URL("../../public/ghostty-web.bundle.js", import.meta.url))).digest("hex"));
  await page.waitForFunction(() => Boolean((window as unknown as { readonly GhosttyWeb: ListenerApi }).GhosttyWeb));
  if (format === "esm") {
    const body = readFileSync(new URL(import.meta.resolve("ghostty-web")));
    await page.route("**/__listener_renderer__.js", (route) => route.fulfill({ body, contentType: "application/javascript" }));
  }
}

for (const format of ["esm", "umd"] as const) {
  for (const eventType of ["beforeinput", "wheel"] as const) {
    test(`disposal releases ${eventType} while preserving container reuse and other owners (${format})`, async ({ page }) => {
      await loadRenderer(page, format);
      const observation = await page.evaluate(async ({ format, eventType }) => {
        const moduleUrl = "/__listener_renderer__.js";
        const api: ListenerApi = format === "esm"
          ? await import(moduleUrl)
          : (window as unknown as { readonly GhosttyWeb: ListenerApi }).GhosttyWeb;
        await api.init();
        const container = document.createElement("div");
        const otherContainer = document.createElement("div");
        document.body.append(container, otherContainer);
        const terminals: ListenerTerminal[] = [];
        let ownerCalls = 0;
        container.addEventListener(eventType, () => { ownerCalls++; }, { capture: true });
        const dispatch = (target: HTMLElement): boolean => {
          const event = eventType === "beforeinput"
            ? new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" })
            : new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 24 });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const open = async (target: HTMLElement): Promise<ListenerTerminal> => {
          const term = new api.Terminal({ ghostty: await api.Ghostty.load(), cols: 40, rows: 8, scrollback: 2000, cursorBlink: false });
          terminals.push(term);
          term.open(target);
          term.write("NATIVE_LISTENER_LIFECYCLE");
          return term;
        };
        try {
          const initiallyCancelled = dispatch(container);
          const other = await open(otherContainer);
          const cycles = [];
          for (let index = 0; index < 3; index++) {
            const term = await open(container);
            const canvas = container.querySelector("canvas");
            const rendered = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
            const liveCancelled = dispatch(container);
            term.dispose();
            term.dispose();
            cycles.push({ rendered, liveCancelled, disposedCancelled: dispatch(container), otherCancelled: dispatch(otherContainer) });
          }
          other.dispose();
          const finalCancelled = dispatch(container);
          return { initiallyCancelled, cycles, finalCancelled, otherDisposedCancelled: dispatch(otherContainer), ownerCalls };
        } finally {
          for (const term of terminals) term.dispose();
          container.remove();
          otherContainer.remove();
        }
      }, { format, eventType });
      expect(observation).toEqual({
        initiallyCancelled: false,
        cycles: Array.from({ length: 3 }, () => ({ rendered: true, liveCancelled: true, disposedCancelled: false, otherCancelled: true })),
        finalCancelled: false,
        otherDisposedCancelled: false,
        ownerCalls: 8,
      });
    });
  }
}
