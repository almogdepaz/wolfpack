import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

for (const state of ["idle", "needs-input"]) test(`SF1: focus writes and ${state === "idle" ? "talk" : "needs-you"} work while only the session list is unavailable`, async ({ page }) => {
  let localDown = false;
  await page.route(`${server.baseUrl}/api/sessions`, async route => {
    if (localDown) return route.fulfill({ status: 503, json: { error: "local session list unavailable" } });
    const response = await route.fetch();
    const body = await response.json();
    const finished = body.sessions.find((s: { name: string }) => s.name === "another-project");
    finished.runtimeState = { ...finished.runtimeState, state: "done", changedAt: new Date().toISOString(), authority: "program", stale: false };
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.state = state;
    if (body.routines) body.routines.catchingUp = null;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next button").first()).toBeEnabled();
  localDown = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(view.locator(".focus-next button").first()).toBeDisabled({ timeout: 10_000 });
  await view.locator(".focus-today summary").first().click();
  await expect(view.locator(".focus-today .focus-card-body [data-focus-session]")).toHaveCount(2);
  for (const button of await view.locator("[data-focus-session]").all()) await expect(button).toBeDisabled();
  expect((await page.request.get(`${server.baseUrl}/api/focus`)).ok()).toBe(true);
  const input = view.getByRole("textbox", { name: "Add an intention" });
  await expect.soft(input).toBeEnabled({ timeout: 1_000 });
  const title = `Session outage focus write ${state}`;
  if (await input.isEnabled()) {
    await input.fill(title);
    await input.press("Enter");
    const checkbox = view.getByRole("checkbox", { name: `Done: ${title}`, exact: true });
    await expect(checkbox).toBeEnabled();
    await checkbox.check();
    await expect(view.locator(".focus-done")).toContainText(title);
  }
  if (state === "idle") await view.getByRole("button", { name: "Talk to assistant" }).click();
  else await view.getByRole("button", { name: /needs you · answer/ }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible({ timeout: 2_000 });
});

test("S2: a retired peer installation leaves the offline snapshot before local recovery", async ({ page }) => {
  const origin = "https://focus-peer.example.ts.net";
  const oldId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const newId = "42d17268-cde1-4b14-990a-44e468ec6333";
  let replaced = false;
  let localDown = false;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [{ hostname: "focus-peer.example.ts.net", tailnetNodeId: "n-focus", origin, online: true }] })));
  await page.route(`${origin}/api/machine`, route => route.fulfill(json({
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-focus", installationId: replaced ? newId : oldId, displayName: "focus peer", origin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  })));
  await page.route(`${origin}/api/sessions`, route => route.fulfill(json({ sessions: [{
    name: replaced ? "replacement-worker" : "retired-worker",
    identity: { wolfpackSessionId: replaced ? "mock:replacement" : "mock:retired" },
    runtimeState: { state: "needs-input", authority: "program", stale: false, changedAt: new Date().toISOString() },
  }] })));
  await page.route(`${server.baseUrl}/api/sessions`, route => localDown ? route.fulfill(json({ error: "local unavailable" }, 503)) : route.continue());
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const next = page.locator("#assistant-content .focus-next");
  await expect(next).toContainText("retired-worker", { timeout: 10_000 });
  localDown = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(next.locator("button").first()).toBeDisabled({ timeout: 10_000 });
  // Unknown/unavailable is not retirement: preserve it until a verified replacement.
  await expect(next).toContainText("retired-worker");
  replaced = true;
  await page.waitForTimeout(1_100); // the discovery refresh's existing minimum interval
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(`.machine-group[data-machine="n-focus:${newId}"]`).first()).toContainText("replacement-worker", { timeout: 10_000 });
  await expect.soft(next).not.toContainText("retired-worker", { timeout: 2_000 });
  await expect(next.locator("button").first()).toBeDisabled();
  localDown = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(next).toContainText("replacement-worker", { timeout: 10_000 });
  await expect(next).not.toContainText("retired-worker");
  await expect(next.locator("button").first()).toBeEnabled();
});

test("QA-14: self-offline keeps last known next rows, disabled, then recovers", async ({ page, context }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next")).toContainText("prompt-project needs you");
  const summaries = await view.locator(".focus-next .focus-card > summary").allTextContents();
  await context.setOffline(true);
  await expect(view).toContainText("offline · read-only", { timeout: 15_000 });
  expect(await view.locator(".focus-next .focus-card > summary").allTextContents()).toEqual(summaries);
  for (const action of await view.locator(".focus-next button, .focus-chips [data-focus-session], .focus-done button").all()) await expect(action).toBeDisabled();
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
  await context.setOffline(false);
  await expect(view).not.toContainText("offline · read-only", { timeout: 15_000 });
  await expect(view.locator(".focus-next button").first()).toBeEnabled();
});
