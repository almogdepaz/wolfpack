import { expect, type Page } from "@playwright/test";
import type { TestServer } from "./helpers";

/** External peer boundary only; local responses still come from the real fixture server. */
export async function remoteFocusHome(page: Page, server: TestServer) {
  const origin = "https://focus-home.example.ts.net";
  const id = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const machine = `n-home:${id}`;
  const state = { failure: "none" as "none" | "identity" | "not-owner" | "store" | "timeout", online: true, handshakeFails: false, present: true };
  const sockets: string[] = [];
  let reads = 0;
  let rejected = 0;
  let held = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const json = (body: unknown) => ({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: state.present ? [{ hostname: "focus-home.example.ts.net", tailnetNodeId: "n-home", origin, online: state.online }] : [] })));
  await page.route(`${origin}/api/machine`, route => state.handshakeFails ? route.abort() : route.fulfill(json({
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-home", installationId: id, displayName: "focus home", origin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  })));
  await page.route(`${origin}/api/sessions`, async route => {
    const response = await route.fetch({ url: `${server.baseUrl}/api/sessions` });
    await route.fulfill({ response, ...json(await response.json()) });
  });
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.local = false; body.home = id;
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.origin === origin && url.pathname === "/api/focus", async route => {
    if (state.failure === "timeout") { held++; await gate; return route.abort(); }
    if (state.failure === "store") return route.fulfill({ status: 503, ...json({ error: "remote focus store unreadable" }) });
    const response = await route.fetch({ url: `${server.baseUrl}/api/focus` }); const body = await response.json();
    body.local = state.failure !== "not-owner";
    body.home = id;
    body.installationId = state.failure === "identity" ? "42d17268-cde1-4b14-990a-44e468ec6333" : id;
    body.document.nudge.text = `remote focus read ${++reads}`;
    if (state.failure === "identity" || state.failure === "not-owner") rejected++;
    await route.fulfill({ response, ...json(body) });
  });
  await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws/pty**`, ws => { sockets.push(ws.url()); });
  return {
    origin, id, machine, state, sockets, release,
    rejected: () => rejected,
    held: () => held,
    async ready() {
      await expect(page.locator(`.machine-group[data-machine="${machine}"]`).first()).toBeVisible();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    },
    async openHealthy() {
      await page.goto(server.baseUrl);
      await this.ready();
      await expect(page.locator("#dashboard-focus .focus-nudge")).toHaveText(/^remote focus read /);
      const opened = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === "/api/focus");
      await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
      await (await opened).finished();
      await expect(page.locator("#assistant-content .focus-nudge")).toHaveText(`remote focus read ${reads}`);
      await expect.poll(() => sockets.length).toBe(1);
    },
  };
}
