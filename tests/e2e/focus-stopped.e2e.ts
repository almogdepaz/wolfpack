import { expandFocusCard } from "./focus-card-helpers";
import { test, expect, type Page } from "@playwright/test";
import { FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";
// Row-content checks use an explicitly expanded dashboard; disclosure defaults have their own coverage.
test.beforeEach(async ({ page }) => { await page.addInitScript(key => localStorage.setItem(key, "1"), FOCUS_MOBILE_EXPANDED_KEY); });
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, openSessionFromUi, toggleSessionGridFromUi, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function runtimeFixture(page: Page, initial: string, target = "test-project", pinned = false) {
  let runtime = { state: initial, authority: initial === "done" ? "program" : "fallback", source: initial === "done" ? "program-status" : "screen-fallback", freshness: "fresh", stale: false,
    changedAt: new Date().toISOString(), stoppedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    transitionSequence: 5, unseen: true, stoppedSequence: initial === "output" ? 0 : 5, acknowledgedSequence: 0 };
  const acknowledgements: { sessionId: string; transitionSequence: number }[] = [];
  const ids = new Map<string, string>();
  let replacementId: string | undefined;
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const session of body.sessions) {
      if (session.name === target && replacementId) session.identity.wolfpackSessionId = replacementId;
      ids.set(session.name, session.identity.wolfpackSessionId);
      if (session.name === target) { session.runtimeState = runtime; session.pinned = pinned; session.identity.agentKind = "custom"; }
      // Remove unrelated attention without altering the assistant's own state.
      if (session.name === "prompt-project" && session.name !== target) session.runtimeState = { ...session.runtimeState, state: "idle", unseen: false, stoppedSequence: 0 };
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/agent-runtime-state/ack", async route => {
    const body = route.request().postDataJSON();
    acknowledgements.push(body);
    if (body.sessionId !== ids.get(target)) return route.continue();
    if (body.transitionSequence !== runtime.transitionSequence) return route.fulfill({ status: 409, json: { error: "new transition" } });
    runtime = { ...runtime, unseen: false, acknowledgedSequence: body.transitionSequence };
    await route.fulfill({ json: { ok: true, runtimeState: runtime } });
  });
  return { acknowledgements, ids, stopTime: runtime.stoppedAt, review: () => { runtime = { ...runtime, unseen: false, acknowledgedSequence: runtime.transitionSequence }; }, metadata: () => { runtime = { ...runtime, unseen: true, transitionSequence: runtime.transitionSequence + 1 }; }, replace: () => { replacementId = "e762d0b1-6d2b-4e37-9168-f2841234abce"; }, stop: (state = "done") => { runtime = { ...runtime, state, unseen: true, transitionSequence: runtime.transitionSequence + 1, stoppedSequence: runtime.transitionSequence + 1, stoppedAt: new Date().toISOString() }; } };
}

test("mark seen acknowledges a done card without opening its terminal", async ({ page }) => {
  const f = await runtimeFixture(page, "done", "prompt-project");
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "prompt-project" });
  await expandFocusCard(row);
  await row.getByRole("button", { name: "mark seen", exact: true }).click();
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("prompt-project"), transitionSequence: 5 });
  await expect(row).toHaveCount(0);
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-done")).toContainText("prompt-project");
});

for (const state of ["done", "idle"]) test(`${state} unseen work has a stopped row; open acknowledges it and removes it`, async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  const f = await runtimeFixture(page, state);
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next li").filter({ hasText: "test-project" });
  await expect(row.locator("summary .focus-title")).toHaveText(`test-project ${state === "done" ? "is done" : "stopped"}`);
  await expect(row.locator("summary .focus-meta")).toContainText("test-project · 12m");
  await expect(row.locator("summary")).not.toContainText("needs you");
  await expect.poll(async () => {
    const box = await row.boundingBox();
    return !!box && box.height >= 60 && box.height <= 160;
  }, { message: "collapsed two-line card retains readable metadata" }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.locator("summary").click();
  await expect(row.getByText("state", { exact: true })).toHaveCount(0);
  await expect(row.locator("summary .focus-tag")).toHaveText(state === "done" ? "done" : "stopped");
  await row.locator("summary").click();
  if (process.env.WOLFPACK_FOCUS_SHOTS) {
    const width = info.project.name === "desktop" ? 1440 : 390;
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `${state}-${width}.png`), fullPage: true });
  }
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const next = page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" });
  await expect(next.locator("summary .focus-meta")).toContainText("12m");
  await expandFocusCard(next);
  await next.getByRole("button", { name: "Open test-project", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 5 });
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
  if (info.project.name === "desktop") {
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#desktop-terminal-container, #terminal-view"))).toBe(true);
    await expect(page.locator("#sidebar-assistant")).not.toContainText("test-project stopped");
    await page.locator("#sidebar-assistant").click();
  } else {
    await page.locator("#back-btn").click();
  }
  await expect(page.locator("#dashboard-focus .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
});

test("QA-28: unreviewed done work stays stopped in next, footer and timeline until reviewed", async ({ page }) => {
  const f = await runtimeFixture(page, "done", "prompt-project");
  f.stop(); // A stop newer than the fixture's completed intention must not lead its footer.
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next .focus-title").first()).toHaveText("prompt-project is done");
  await expect(block.locator(":scope > .focus-dashboard-body > small").last()).not.toContainText("prompt-project finished");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-done")).not.toContainText("prompt-project");
  await expect(view.getByRole("heading", { name: /done today/ })).toContainText("0 sessions");
  f.review();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(view.locator(".focus-done")).toContainText("prompt-project finished");
  await expect(view.getByRole("heading", { name: /done today/ })).toContainText("1 session");
  await expect(block.locator(":scope > .focus-dashboard-body > small").last()).toContainText("prompt-project finished");
});

test("QA-33: reviewed done leaves next and keeps its original stop time in done today", async ({ page }) => {
  const f = await runtimeFixture(page, "done", "prompt-project");
  f.review();
  // Keep the stop in the activity day under test, including around midnight.
  await page.clock.setFixedTime(new Date(Date.parse(f.stopTime) + 60_000));
  await page.goto(server.baseUrl);
  const stopClock = await page.evaluate(at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), f.stopTime);
  await expect(page.locator("#dashboard-focus .focus-next li").filter({ hasText: "prompt-project" })).toHaveCount(0);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next li").filter({ hasText: "prompt-project" })).toHaveCount(0);
  const row = view.locator(".focus-done li").filter({ hasText: "prompt-project finished" });
  await expect(row).toBeVisible();
  await expect(row.locator(".focus-time")).toHaveText(stopClock);
});

test("reviewed work stays out of next when metadata becomes unseen again", async ({ page }) => {
  const f = await runtimeFixture(page, "done");
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next li").filter({ hasText: "test-project" });
  await expandFocusCard(row);
  await row.getByRole("button", { name: "Open test-project", exact: true }).click();
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 5 });
  f.metadata();
  await page.goto(server.baseUrl);
  const card = page.locator("#session-list .card").filter({ has: page.locator(".card-name-text").filter({ hasText: /^test-project$/ }) });
  await expect(card.locator(".session-activity")).toHaveText("changed since review");
  await expect(page.locator("#dashboard-focus .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
});

test("server-owned pinned sessions stay in ordinary lists but never rank as stopped work", async ({ page }) => {
  await runtimeFixture(page, "idle", "test-project", true);
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list .card-name-text").filter({ hasText: /^test-project$/ })).toBeVisible();
  await expect(page.locator("#dashboard-focus .focus-quiet")).toHaveText("nothing needs you · 1 working");
  await expect(page.locator("#dashboard-focus .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
});

test("linked stopped work leads the sidebar up-next without a needs-you tone", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar");
  await runtimeFixture(page, "idle", "prompt-project");
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await openSessionFromUi(page, "another-project");
  await expect(page.locator("#sidebar-assistant")).toContainText("prompt-project stopped");
  await expect(page.locator("#sidebar-assistant")).toHaveAttribute("data-tone", "rest");
});

test("an unfocused browser does not acknowledge a turn end until foregrounded", async ({ page }) => {
  const f = await runtimeFixture(page, "output");
  await page.goto(server.baseUrl);
  await openSessionFromUi(page, "test-project");
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 5 });
  // Headless Chromium reports both tabs focused. Emulate only this browser-owned input;
  // session refresh, terminal ownership and acknowledgement remain the real application path.
  await page.evaluate(() => { document.hasFocus = () => false; });
  f.stop();
  // Force a real refresh while the visible page lacks window focus.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toContainText("stopped", { timeout: 15_000 });
  expect(f.acknowledgements.filter(a => a.transitionSequence === 6)).toHaveLength(0);
  await page.evaluate(() => { delete (document as unknown as { hasFocus?: unknown }).hasFocus; window.dispatchEvent(new Event("focus")); });
  await expect.poll(() => f.acknowledgements, { timeout: 15_000 }).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 6 });
});

test("a reused name cannot acknowledge a replacement session through the old terminal", async ({ page }) => {
  const f = await runtimeFixture(page, "output");
  await page.goto(server.baseUrl);
  await openSessionFromUi(page, "test-project");
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 5 });
  f.replace();
  f.stop();
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toContainText("stopped", { timeout: 15_000 });
  expect(f.acknowledgements.filter(a => a.transitionSequence === 6)).toHaveLength(0);
});

test("a turn ending while the user watches the terminal is acknowledged again", async ({ page }) => {
  const f = await runtimeFixture(page, "output");
  await page.goto(server.baseUrl);
  await openSessionFromUi(page, "test-project");
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 5 });
  f.stop();
  await expect.poll(() => f.acknowledgements, { timeout: 15_000 }).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 6 });
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toHaveCount(0);
});

test("only the focused grid cell is watched; focusing a stopped cell acknowledges it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop grid");
  const f = await runtimeFixture(page, "output");
  await page.goto(server.baseUrl);
  await toggleSessionGridFromUi(page, "test-project");
  await toggleSessionGridFromUi(page, "another-project");
  const grid = page.locator("#desktop-grid-container");
  await expect(grid.locator(".grid-cell")).toHaveCount(2);
  await grid.locator('[data-session="another-project"] .grid-cell-header').click();
  await expect(grid.locator(".grid-focused")).toHaveAttribute("data-session", "another-project");
  f.stop("idle");
  await expect(page.locator("#assistant-content .focus-next li").filter({ hasText: "test-project" })).toContainText("stopped", { timeout: 15_000 });
  expect(f.acknowledgements.filter(a => a.sessionId === f.ids.get("test-project") && a.transitionSequence === 6)).toHaveLength(0);
  await grid.locator('[data-session="test-project"] .grid-cell-header').click();
  await expect.poll(() => f.acknowledgements).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 6 });
  f.stop();
  await expect.poll(() => f.acknowledgements, { timeout: 15_000 }).toContainEqual({ sessionId: f.ids.get("test-project"), transitionSequence: 7 });
});
