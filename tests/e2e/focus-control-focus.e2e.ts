import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function openFocus(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-next button").first()).toBeEnabled();
}

for (const control of [".focus-next button", "input[data-focus-done]"]) {
  test(`R1: outage refresh returns a newly disabled ${control} to the visible list`, async ({ page }) => {
    let down = false;
    await page.route(url => url.pathname === "/api/focus", route => down ? route.abort() : route.continue());
    await openFocus(page);
    const button = page.locator(`#assistant-content ${control}`).first();
    await button.focus();
    await expect(button).toBeFocused();
    down = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#assistant-content .focus-header")).toContainText("offline · read-only");
    await expect(button).toBeDisabled();
    await expect(page.locator(".assistant-column")).toBeFocused();
  });
}

test("R1: slow completion keeps list focus through a refresh while saving and after removal", async ({ page }) => {
  let posted = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() === "POST") { posted = true; await gate; }
    await route.continue();
  });
  try {
    await openFocus(page);
    const checkbox = page.getByRole("checkbox", { name: "Done: ship the focus assistant", exact: true });
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => posted).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(checkbox).toBeDisabled();
    await expect.soft(page.locator(".assistant-column")).toBeFocused();
    release();
    await expect(page.locator("#assistant-content .focus-done")).toContainText("ship the focus assistant");
    await expect(page.locator(".assistant-column")).toBeFocused();
  } finally { release(); }
});

for (const [name, selector, dashboard = false, expand = false] of [
  ["dashboard title", "#dashboard-focus [aria-label='Open assistant']", true],
  ["dashboard open assistant", "#dashboard-focus [aria-label='Open assistant page']", true],
  ["settings", "#assistant-content [aria-label='Assistant settings']"],
  ["talk", "#assistant-content .focus-talk"],
  ["catch up now", "#assistant-content [data-focus-action='catch-up']"],
  ["chip", "#assistant-content .focus-today > li:first-child > .focus-chips [data-focus-session]:visible"],
  ["chip more", "#assistant-content .focus-chip-more:visible"],
  ["expanded chip", "#assistant-content .focus-today .focus-card-body [data-focus-session]", false, true],
  ["done undo", "#assistant-content .focus-done [data-focus-undo]"],
  ["done open", "#assistant-content .focus-done [data-focus-session]"],
  ["add submit", "#assistant-content .focus-add button"],
] as const) {
  test(`N1: ${name} keeps its own focus across a changed render`, async ({ page }, info) => {
    test.skip(name === "chip more" && info.project.name !== "desktop", "phone shows all compact chips");
    let render = 0;
    const extras = ["r", "s", "t", "u"];
    await page.route("**/api/sessions", async route => {
      const response = await route.fetch();
      const body = await response.json();
      const finished = body.sessions.find((s: { name: string }) => s.name === "another-project");
      finished.runtimeState = { ...finished.runtimeState, state: "done", unseen: false, stoppedSequence: 1, acknowledgedSequence: 1, changedAt: new Date().toISOString() };
      body.sessions.push(...extras.map(name => ({ ...finished, name,
        identity: { ...finished.identity, wolfpackSessionId: `mock:${name}` },
        runtimeState: { ...finished.runtimeState, state: "working" },
      })));
      await route.fulfill({ response, json: body });
    });
    await page.route(url => url.pathname === "/api/focus", async route => {
      const response = await route.fetch();
      const body = await response.json();
      const intention = body.document.intentions.find((i: { id: string }) => i.id === "ship");
      intention.done = false;
      delete intention.doneAt;
      intention.sessions = ["mock:prompt-project", "mock:another-project", ...extras.map(name => `mock:${name}`)];
      body.document.nudge = { text: `Focus refresh ${render}`, updatedAt: new Date().toISOString(), author: "assistant" };
      body.routines = { catchingUp: null, stale: { since: new Date(Date.now() - 900_000).toISOString() }, unreachable: [], surfaced: null };
      await route.fulfill({ response, json: body });
    });
    if (dashboard) await page.goto(server.baseUrl);
    else await openFocus(page);
    const host = page.locator(dashboard ? "#dashboard-focus" : "#assistant-content");
    if (expand) await host.locator(".focus-today > li:first-child summary").click();
    const control = page.locator(selector).first();
    await expect(control).toBeVisible();
    await control.focus();
    await expect(control).toBeFocused();
    const previous = await control.elementHandle();
    render++;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(host.locator(".focus-nudge")).toHaveText(`Focus refresh ${render}`);
    expect(await previous!.evaluate(el => el.isConnected), "a changed render actually replaced the control").toBe(false);
    await expect(control).toBeFocused();
  });
}
