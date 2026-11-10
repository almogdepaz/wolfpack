import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { remoteFocusHome } from "./focus-home-fixture";
import { FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";
let server: TestServer;
test.beforeEach(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterEach(async ({ page }) => { await page.close(); await server?.close(); });

for (const project of [undefined, "/work/focus-project"]) test(`L5: ${project ? "project-linked" : "title-only"} start reports a home retired between polls`, async ({ page }) => {
  const title = "start after home replacement";
  const before = await (await fetch(server.baseUrl + "/api/focus")).json();
  expect((await fetch(server.baseUrl + "/api/focus", { method: "POST", body: JSON.stringify({ expectedRevision: before.revision, ops: [{ type: "add", intention: { id: "offline-start", title, ...(project ? { project } : {}) } }] }) })).status).toBe(200);
  await page.addInitScript(key => localStorage.setItem(key, "1"), FOCUS_MOBILE_EXPANDED_KEY);
  await page.clock.install();
  const home = await remoteFocusHome(page, server);
  // No work agents yet: starting the sole intention is the next action on both devices.
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch({ url: server.baseUrl + "/api/sessions" }); const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => s.name === "assistant");
    await route.fulfill({ response, headers: { "Access-Control-Allow-Origin": "*" }, json: body });
  });
  const errors: string[] = [], mutations: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && ["/api/create", "/api/focus"].includes(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(server.baseUrl); await home.ready();
    const loaded = page.waitForResponse(response => new URL(response.url()).origin === home.origin && new URL(response.url()).pathname === "/api/focus");
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await (await loaded).finished();
    const start = page.locator("#assistant-content").getByRole("button", { name: `start “${title}”`, exact: true });
    await expect(start).toBeEnabled();
    // Hold the next focus read so discovery can retire the home before Focus observes it.
    await page.route(url => url.pathname === "/api/focus", async route => { await gate; await route.abort(); });
    const replacement = "42d17268-cde1-4b14-990a-44e468ec6333";
    await page.route(`${home.origin}/api/machine`, route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: { tailnetNodeId: "n-home", installationId: replacement, displayName: "replacement home", origin: home.origin },
      wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    } }));
    await page.clock.fastForward(1_100); // existing discovery minimum interval, not a wall-clock sleep
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(`#session-list .machine-group[data-machine="n-home:${replacement}"]`)).toHaveCount(1);
    await expect(page.locator(`#session-list .machine-group[data-machine="${home.machine}"]`)).toHaveCount(0);
    await expect(start).toBeEnabled();
    await start.click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(errors, "the click must not throw or reject an unobserved picker promise").toEqual([]);
    await expect(page.locator("#app-dialog-message")).toHaveText("focus home is offline; changes were not saved");
    await expect(page.locator("#assistant-view")).toHaveClass(/visible/);
    await expect(page.locator("#projects-view")).not.toHaveClass(/visible/);
    await expect(page.locator("#agent-view")).not.toHaveClass(/visible/);
    expect(mutations).toEqual([]);
  } finally { release(); home.release(); }
});
