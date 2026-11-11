import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("mixed cards, waiting line and grouped done work expose the next decision", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: desktop ? 1200 : 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => { localStorage.setItem("wolfpack-sidebar-pinned", "1"); localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1"); });
  const now = new Date(); now.setHours(12, 0, 0, 0);
  await page.clock.setFixedTime(now);
  const at = (hours: number, minutes = 0) => { const d = new Date(now); d.setHours(hours, minutes); return d.toISOString(); };
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [
    ...current.document.intentions.map((i: { id: string }) => ({ type: "drop", id: i.id })),
    { type: "add", intention: { id: "ship", title: "Ship the release safely", sessions: ["mock:release-main"] } },
    { type: "add", intention: { id: "docs", title: "Document the rollout", sessions: [] } },
    { type: "add", intention: { id: "migrate", title: "Review the database migration", sessions: ["mock:migrate-1"] } },
    { type: "done", id: "ship" }, { type: "done", id: "docs" },
    { type: "next", author: "assistant", rows: [{ ref: { machine: current.installationId, sessionId: "mock:continuation" }, stoppedAt: at(11), verdict: "suggest", reason: "Step 2 added beta; step 3 is a small continuation", suggestion: "Continue with step 3: add gamma to notes.txt; keep the scope unchanged." }] },
  ] } })).ok()).toBe(true);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json(); delete body.routines;
    body.document.intentions.find((i: { id: string }) => i.id === "ship").doneAt = at(9, 22);
    body.document.intentions.find((i: { id: string }) => i.id === "docs").doneAt = at(8, 5);
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    body.document.daySummary = { date: `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`, done: 3, carried: 2, questions: 1 };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    const rows = [
      { name: "me-2", state: "needs-input", line: "Choose bun add or vendoring?" },
      { name: "continuation", state: "done", line: "Step 2 done, beta added. Continue with step 3?" },
      { name: "docs-pass", state: "done", line: "Documentation complete." },
      { name: "api-refactor", state: "idle", line: "Waiting for workers." },
      { name: "worker", state: "working", parent: "api-refactor" },
      { name: "worker-finished", state: "done", parent: "api-refactor" },
      { name: "release-main", state: "done", seen: true, time: at(9, 10) },
      { name: "migrate-1", state: "done", seen: true, time: at(8, 40) },
    ];
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...rows.map(row => ({ ...template, name: row.name, lastLine: row.line ?? "",
      identity: { ...template.identity, wolfpackSessionId: `mock:${row.name}`, projectPath: "/work/wolfpack", ...(row.parent ? { parentSession: { wolfpackSessionId: `mock:${row.parent}`, wolfpackSessionName: row.parent } } : {}) },
      runtimeState: { ...template.runtimeState, state: row.state, inputKind: row.state === "needs-input" ? "question" : undefined, changedAt: row.time ?? at(11), stoppedAt: row.time ?? at(11), unseen: !row.seen, stoppedSequence: 5, acknowledgedSequence: row.seen ? 5 : 0 },
    }))];
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  const replyCard = block.locator(".focus-next > li").filter({ hasText: "Step 2 added beta" });
  await expandFocusCard(replyCard);
  await expect(block.locator(".focus-quiet")).toContainText("api-refactor waiting on 2 sub-sessions (1 working)");
  const counts = "1 needs you · 1 reply ready · 1 done";
  await expect.soft(block.locator(".focus-dashboard-body > small").last()).toHaveText(`${counts} · today 2 of 3 done`);
  const unjudged = block.locator(".focus-next > li").filter({ hasText: "me-2" });
  await expect.soft(unjudged.locator("summary q")).toHaveText("Choose bun add or vendoring?");
  await expect(unjudged.locator("summary .focus-title")).toHaveText("me-2 asks a question");
  await expect(unjudged.locator("summary q > *")).toHaveCount(0);
  const chevron = [-135, 3];
  await expect.poll(() => replyCard.locator("summary").evaluate(el => {
    const m = new DOMMatrix(getComputedStyle(el, "::after").transform);
    return [Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI), m.f];
  })).toEqual(chevron);
  await page.emulateMedia({ reducedMotion: "reduce" }); // Capture the settled pose, never a transition midpoint.
  const shots = process.env.WOLFPACK_FOCUS_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: join(shots, `dashboard-${desktop ? "desktop" : "390"}.png`), fullPage: true });
    if (!desktop) {
      await page.setViewportSize({ width: 390, height: 1800 });
      await block.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: join(shots, "dashboard-390-full.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
  }
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect.soft(view.locator(":scope > h2").first()).toHaveText(`next ${counts}`);
  if (desktop) {
    const pill = page.locator("#sidebar-assistant .assistant-tile-state");
    await expect(pill).toHaveText("1 needs you +2:");
    await expect(pill).toHaveAttribute("title", counts);
    await expect(page.locator("#sidebar-assistant-nav")).toHaveAccessibleDescription(counts);
    expect((await pill.boundingBox())!.height, "the tile count stays on one line").toBeLessThanOrEqual(20);
    expect(await page.locator("#sidebar-assistant .assistant-tile-state").evaluate(el => {
      const rect = el.getBoundingClientRect(), button = el.closest("button")!.getBoundingClientRect();
      return rect.right <= button.right && el.scrollWidth <= el.clientWidth;
    }), "the shared count stays readable inside the existing sidebar tile").toBe(true);
  }
  expect(await view.locator(".focus-next > li").filter({ hasText: "Step 2 added beta" }).locator("summary").evaluate(el => {
    const m = new DOMMatrix(getComputedStyle(el, "::after").transform);
    return [Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI), m.f];
  })).toEqual(chevron);
  await expect(view.getByRole("heading", { name: /^done today/ })).toHaveText("done today 2 finished · 1 finished work still open");
  const finished = view.getByRole("list", { name: "Finished intentions", exact: true });
  const open = view.getByRole("list", { name: "Finished work still open", exact: true });
  await expect(finished.locator(":scope > li")).toHaveCount(2);
  await expect(finished.locator(":scope > li").first()).toContainText("Ship the release safely");
  await expect(finished.locator(":scope > li").first()).toContainText("release-main");
  await expect(open.locator(":scope > li")).toHaveCount(1);
  await expect(open).toContainText("Review the database migration");
  await expect(open.getByRole("button", { name: "Mark done: Review the database migration", exact: true })).toBeEnabled();
  await expect.soft(finished).toHaveCSS("border-top-width", "1px");
  await expect.soft(finished).toHaveCSS("padding-left", "12px");
  await expect.soft(view.locator(".focus-done h3").first()).toHaveCSS("text-transform", "uppercase");
  if (desktop) expect(await view.locator(".focus-done").evaluate(el => el.getBoundingClientRect().width)).toBe(720);
  for (const button of await view.locator(".focus-done button").all()) {
    expect(await button.evaluate(el => {
      const bounds = el.closest(".focus-done")!.getBoundingClientRect(), rect = el.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    }), "done controls stay inside the 720px/390px container, including element screenshots").toBe(true);
  }
  await expect(view.locator(".focus-yesterday")).toHaveText("yesterday· 1 question for you · 2 carried over · 3 doneread ›");
  const finishClock = await page.evaluate(at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), at(11));
  await expect.soft(view.locator('.focus-next > [data-kind="done"] span.focus-meta')).toContainText(finishClock);
  await expect.soft(replyCard.locator("dt").first()).toHaveText("last line");
  await expect.soft(view.locator(".focus-header")).toContainText(/ordered (just now|\d+[mhd] ago)/);
  const why = view.locator(":scope > details").filter({ hasText: "why this order" });
  await expect.soft(why.locator("summary")).toHaveCSS("min-height", desktop ? "24px" : "44px");
  if (!desktop) {
    const read = view.locator(".focus-yesterday button");
    const readBox = (await read.boundingBox())!;
    const lineBox = (await view.locator(".focus-yesterday").boundingBox())!;
    expect.soft(readBox.y + readBox.height / 2, "read stays beside yesterday's summary, not below it").toBeLessThan(lineBox.y + lineBox.height - readBox.height / 2 + 1);
    expect.soft(await read.evaluate(el => el.getBoundingClientRect().top <= el.previousElementSibling!.getBoundingClientRect().bottom)).toBe(true);
  }
  for (const width of desktop ? [1024, 1280, 1440] : [390]) {
    await page.setViewportSize({ width, height: desktop ? 1200 : 844 });
    for (const time of await view.locator(".focus-done .focus-time").all()) await expect(time).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).include("#assistant-content").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) {
    await page.screenshot({ path: join(shots, `assistant-${desktop ? "desktop" : "390"}.png`), fullPage: true });
    await view.locator(".focus-done").screenshot({ path: join(shots, `done-today-${desktop ? "desktop" : "390"}.png`) });
    if (!desktop) {
      await page.setViewportSize({ width: 390, height: 1800 });
      await page.locator("#assistant-view").evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: join(shots, "assistant-390-full.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
  }
  await open.getByRole("button", { name: "Mark done: Review the database migration", exact: true }).click();
  await expect(view.getByRole("list", { name: "Finished work still open", exact: true })).toHaveCount(0);
  await expect(finished.locator(":scope > li")).toHaveCount(3);
  await finished.getByRole("button", { name: "Undo done: Review the database migration", exact: true }).click();
  await expect(open.locator(":scope > li")).toHaveCount(1);
});
