import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

async function fixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpackCursorBlinkDisabled", "1");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/info", route => route.fulfill({ json: { name: "Workstation", version: "1.6.26" } }));
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  const session = (name: string, state: string, parent?: string) => ({
    name, lastLine: name === "waiting" ? "Allow this change? (y/n)" : "Tests passed. Ready for review.",
    identity: { wolfpackSessionId: name, agentKind: name === "solo" ? "claude" : "pi", ...(parent ? { parentSession: { wolfpackSessionId: parent, wolfpackSessionName: parent } } : {}) },
    runtimeState: { state, authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false, changedAt: "2026-10-21T11:59:00Z" },
    meta: { model: "gpt-6-astra", reasoning: "medium", contextPct: 85, contextLimit: 272000, cost: 0.02, costTag: "sub" },
  });
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [session("waiting", "needs-input"), session("solo", "working"), session("parent", "idle"), session("child", "working", "parent"), session("outside", "idle")] } }));
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== "string") return;
    const data = JSON.parse(message);
    if (data.type !== "attach") return;
    socket.send(JSON.stringify({ type: "attach_ack" }));
    socket.send(Buffer.from("PRESERVED TERMINAL\r\n"));
    if (data.prefillMode === "viewport") socket.send(JSON.stringify({ type: "prefill_viewport" }));
    socket.send(JSON.stringify({ type: "prefill_done" }));
    socket.send(JSON.stringify({ type: "pty_ready" }));
  }));
}

for (const width of [1440, 390]) {
  test(`trim preserves dashboard, pinned, terminal and grid at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== (width === 1440 ? "desktop" : "iphone-14"), "one controlled capture per viewport");
    test.setTimeout(60_000);
    const output = process.env.TRIM_CAPTURE_DIR || info.outputPath("trim-captures");
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto(server.baseUrl);
    await expect(page.locator("#session-list .needs-you .card")).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    const capture = async (name: string, selector?: string) => {
      await page.mouse.move(width - 1, 899);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const path = join(output, `${name}-${width}.png`);
      if (selector) await page.locator(selector).screenshot({ path, animations: "disabled", caret: "hide" });
      else await page.screenshot({ path, animations: "disabled", caret: "hide" });
      const styles = await page.evaluate(() => {
        const pathFor = (node: Element): string => node.id ? `#${node.id}` : node.parentElement ? `${pathFor(node.parentElement)}>${node.tagName.toLowerCase()}:nth-child(${Array.from(node.parentElement.children).indexOf(node) + 1})` : node.tagName;
        const result: Record<string, Record<string, string>> = {};
        for (const node of document.querySelectorAll("body, body *")) {
          const style = getComputedStyle(node);
          result[pathFor(node)] = Object.fromEntries(Array.from(style).map(key => [key, style.getPropertyValue(key)]));
        }
        return result;
      });
      await writeFile(join(output, `${name}-${width}.styles.json`), JSON.stringify(styles));
    };
    await capture("dashboard");
    await capture("pinned", "#session-list .needs-you");
    await page.locator("#session-list .needs-you").getByRole("button", { name: "Open waiting", exact: true }).click();
    await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
    await expect(page.locator("#needs-input-banner")).toBeVisible();
    await capture("terminal");
    // Grid entry is desktop-only. Seed it through the real desktop controls,
    // then capture its existing responsive state at the requested mobile width.
    if (width === 390) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.locator("#session-list .needs-you").getByRole("button", { name: "Open waiting", exact: true }).click();
      await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
    }
    const row = (name: string) => page.locator(`#sidebar-session-list [data-session-order-id="${name}"]`);
    await row("solo").getByRole("button", { name: "Add to grid: solo", exact: true }).click();
    await row("parent").getByRole("button", { name: "Expand 1 child agent", exact: true }).click();
    await row("child").getByRole("button", { name: "Add to grid: child", exact: true }).click();
    await expect(page.locator("#desktop-grid-container .grid-cell")).toHaveCount(3);
    for (const name of ["waiting", "solo", "child"]) await expect(row(name).locator(".grid-btn")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#sidebar-search").focus();
    if (width === 390) await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#desktop-grid-container")).toBeVisible();
    await capture("grid-markers");
  });
}
