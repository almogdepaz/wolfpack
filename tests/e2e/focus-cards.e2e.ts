import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";
import { SESSION_UUID, v3, withContext } from "./focus-context-fixture";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const noHorizontalScroll = () => document.documentElement.scrollWidth <= innerWidth;

test("a next row expands to its session details; the action acts without toggling; open survives a re-render", async ({ page }) => {
  // the mock backend reports no project path; give prompt-project one so the card shows it
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").identity.projectPath = "/home/dev/demo-app";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  const card = row.locator("details.focus-card");
  await expect(card).not.toHaveAttribute("open", /.*/);
  await row.locator(".focus-card > summary").click();
  await expect(card).toHaveAttribute("open", "");
  const body = card.locator(".focus-card-body");
  await expect(body.locator("[title='/home/dev/demo-app']")).toHaveText("demo-app");
  await expect(body).toContainText(/needs you · since \d+[mhd]|needs you · since now/);
  await expect(body).toContainText("Do you want to continue? (y/n)");
  await expect(body).toContainText("Needs you for this intention");
  await expect(body).toContainText("ship the focus assistant");
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  // a focus write bumps the revision; the next poll re-renders the block and the card stays open
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "nudge", text: "Answer prompt-project, then ship.", author: "assistant" }] } })).ok()).toBe(true);
  await expect(block).toContainText("Answer prompt-project, then ship.", { timeout: 15_000 });
  await expect(card).toHaveAttribute("open", "");
  // keyboard: the summary toggles natively; the action follows it in the tab order
  await row.locator(".focus-card > summary").focus();
  await page.keyboard.press("Enter");
  await expect(card).not.toHaveAttribute("open", /.*/);
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: /prompt-project/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

test("today intentions expand to their details; the checkbox and chips work without toggling the card", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  const item = view.locator(".focus-today li").filter({ hasText: "fix broker leak" });
  const card = item.locator("details.focus-card");
  await view.getByRole("checkbox", { name: "Done: fix broker leak" }).check();
  await expect(view).toContainText("2 of 3 done");
  await expect(view.locator(".focus-today details.focus-card[open]")).toHaveCount(0);
  await view.locator(".focus-done").getByRole("button", { name: "Undo done: fix broker leak" }).click();
  await expect(view).toContainText("1 of 3 done");
  await item.locator(".focus-card > summary").click();
  await expect(card).toHaveAttribute("open", "");
  await expect(card.locator(".focus-card-body")).toContainText(/sessions\s*none yet/);
  await expect(card.locator(".focus-card-body")).toContainText(/added\s*\w+ \d+, \d\d:\d\d/);
  const linked = view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" });
  await linked.locator(".focus-card > summary").click();
  await expect(linked.locator(".focus-card-body")).toContainText("prompt-project");
  await expect(linked.locator(".focus-card-body")).toContainText("another-project");
  // an open today card lists its sessions in the body; the chips beside it hide until it closes (Q2)
  await expect(linked.locator(".focus-chips")).toBeHidden();
  // the next-row card for the same session is a separate card on this page; both stay open across a poll
  await view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator(".focus-card > summary").click();
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  await page.waitForTimeout(6000);
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  await linked.locator(".focus-card > summary").click();
  await expect(linked.locator(".focus-chips")).toBeVisible();
  await linked.locator(".focus-chips").getByRole("button", { name: "another-project" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

test("a session card shows the agent's context document, fetched only while it is open", async ({ page }) => {
  const reads = await withContext(page, v3);
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await expect(row).toBeVisible();
  await page.waitForTimeout(6000);
  expect(reads).toEqual([]);
  await row.locator(".focus-card > summary").click();
  const context = row.locator(".focus-context");
  await expect(context).toContainText("context");
  expect(reads[0]).toBe(SESSION_UUID);
  await expect(context).toContainText("Ship the focus cards round");
  await expect(context).toContainText("Wire the context block into session cards");
  // every needs-you item is its own element keyed by its id; five show, the rest sit under "2 more"
  await expect(context.locator("[data-focus-need]")).toHaveCount(7);
  await expect(context.locator(".focus-needs > [data-focus-need]")).toHaveCount(5);
  await expect(context.locator('[data-focus-need="approve-copy"]')).toHaveText("Approve the <img src=x onerror=alert(1)> state copy");
  await expect(context.locator("img")).toHaveCount(0);
  await expect(context.locator('[data-focus-need="q-f"]')).toBeHidden();
  await context.getByText("2 more").click();
  await expect(context.locator('[data-focus-need="q-f"]')).toBeVisible();
  await expect(context).toContainText(/Run the e2e\s*agent/);
  await expect(context).toContainText(/Look at the captures\s*user/);
  await expect(context).toContainText("pi 1.3.0 here");
  await expect(context).not.toContainText("fourth fact stays out");
  await expect(context).not.toContainText("Cards over a drawer");
  await expect(context).toContainText("reviewed · updated 5m");
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  // refreshed with the 5 s poll while open; the nested "more" stays open across it; nothing is fetched once collapsed
  await expect.poll(() => reads.length, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(context.locator('[data-focus-need="q-f"]')).toBeVisible();
  await row.locator(".focus-card > summary").click();
  const settled = reads.length;
  await page.waitForTimeout(6000);
  expect(reads.length).toBe(settled);
  expect(errors).toEqual([]);
});

test("no document is no block; another schema version is one line", async ({ page }) => {
  await withContext(page, null);
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect(row.locator(".focus-card-body").first()).toContainText("Do you want to continue? (y/n)");
  await page.waitForTimeout(1000);
  await expect(row.locator(".focus-context")).toHaveCount(0);
  await page.unroute(url => url.pathname === "/api/extensions/documents/agent-context/context");
  await page.route(url => url.pathname === "/api/extensions/documents/agent-context/context", route => route.fulfill({ json: { document: { schemaVersion: 1, goal: "legacy", planItems: [] } } }));
  await expect(row.locator(".focus-context")).toHaveText(/context\s*context panel v1 not shown/, { timeout: 15_000 });
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
});

test("open cards refreshing their context do not drop a half-typed ask", async ({ page }) => {
  await withContext(page, v3);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  await view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator(".focus-card > summary").click();
  await view.locator(".focus-today li").filter({ hasText: "fix broker leak" }).locator(".focus-card > summary").click();
  await expect(view.locator(".focus-context")).toBeVisible();
  const box = view.getByRole("textbox", { name: "Ask the assistant" });
  await box.click();
  await box.pressSequentially("half typed");
  // two polls with the context reloads and their renders
  await page.waitForTimeout(11_000);
  await expect(box).toHaveValue("half typed");
  await expect(box).toBeFocused();
  await page.keyboard.type(" ask");
  await expect(box).toHaveValue("half typed ask");
});

test("a poll answered before a tick lands after it without reverting the tick (S2)", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  await expect(view).toContainText("1 of 3 done");
  let hold = false;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const conflicts: number[] = [];
  page.on("response", response => { if (new URL(response.url()).pathname === "/api/focus" && response.request().method() === "POST" && response.status() === 409) conflicts.push(409); });
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET" || !hold) return route.continue();
    hold = false;
    // the server answers now (the older revision); the page sees it only after the tick
    const response = await route.fetch();
    arrived();
    await released;
    await route.fulfill({ response });
  });
  hold = true;
  await held;
  await view.getByRole("checkbox", { name: "Done: fix broker leak" }).check();
  await expect(view).toContainText("2 of 3 done");
  release();
  await page.waitForTimeout(1000);
  expect(await view.textContent()).toContain("2 of 3 done");
  await view.locator(".focus-done").getByRole("button", { name: "Undo done: fix broker leak" }).click();
  await expect(view).toContainText("1 of 3 done");
  expect(conflicts).toEqual([]);
  await page.unroute(url => url.pathname === "/api/focus");
});

test("a session card whose row left next stops fetching; it may come back open (S3)", async ({ page }) => {
  let working = false;
  const reads = await withContext(page, v3, session => {
    if (working) session.runtimeState = { ...(session.runtimeState as object), state: "working", authority: "program", stale: false };
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect(row.locator(".focus-context")).toBeVisible();
  working = true;
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  const gone = reads.length;
  await page.waitForTimeout(11_000);
  expect(reads.length).toBe(gone);
  working = false;
  await expect(row.locator("details.focus-card")).toHaveAttribute("open", "", { timeout: 15_000 });
  await expect.poll(() => reads.length, { timeout: 15_000 }).toBeGreaterThan(gone);
});

test("a machine that answers not installed is not asked again every poll (N2)", async ({ page }) => {
  const reads = await withContext(page, v3);
  await page.unroute(url => url.pathname === "/api/extensions/documents/agent-context/context");
  await page.route(url => url.pathname === "/api/extensions/documents/agent-context/context", route => {
    reads.push("not-installed");
    return route.fulfill({ status: 404, json: { error: { code: "NOT_INSTALLED", message: "extension is not installed" } } });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect.poll(() => reads.length).toBe(1);
  await page.waitForTimeout(11_000);
  expect(reads.length).toBe(1);
  await expect(row.locator(".focus-context")).toHaveCount(0);
});

test("disclosure markers are not the action's glyph and are silent to screen readers (C1, N5)", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  await expect(view.locator(".focus-next details.focus-card").first()).toBeVisible();
  const marker = (selector: string, pseudo: string) => view.locator(selector).first().evaluate((el, p) => getComputedStyle(el, p).content, pseudo);
  // the card's marker is drawn, not a "›" beside the "start ›" action
  expect(await marker(".focus-next details.focus-card > summary", "::after")).not.toContain("›");
  expect(await marker(".focus-today details.focus-card > summary", "::after")).not.toContain("›");
  // glyph markers carry empty alternative text
  expect(await marker("details:not(.focus-card) > summary", "::before")).toBe('"›" / ""');
});
