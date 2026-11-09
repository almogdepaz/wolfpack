import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const [state, inputKind, label, verb] of [
  ["needs-input", "permission", "permission", "approve"],
  ["needs-input", "question", "question", "answer"],
  ["needs-input", "auth", "auth", "log in"],
  ["needs-input", undefined, "needs you", "open"],
  ["failed", "permission", "failed", "retry"],
  ["done", "question", "stopped", "review"],
  ["idle", undefined, "stopped", "review"],
] as const) test(`row truth: ${state}/${inputKind ?? "unknown"} says ${label} and ${verb}`, async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.runtimeState = { ...s.runtimeState, state, inputKind, unseen: true, stoppedSequence: 5,
      acknowledgedSequence: 0, changedAt: new Date(Date.now() - 720_000).toISOString() };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await expect(row.locator("summary .focus-title")).toHaveText(`prompt-project ${label} · 12m`);
  await expect(row.getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true })).toHaveText(`${verb} ›`);
  await expect(block.getByRole("button", { name: "start “fix broker leak”", exact: true })).toHaveText("start ›");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const action = page.locator("#assistant-content").getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true });
  await expect(action).toHaveText(`${verb} ›`);
  await expect(page.locator("#sidebar-assistant .assistant-tile-next")).toContainText(`prompt-project ${label}`);
  // All verbs navigate through the existing session opener, including retry (not a restart).
  const socket = page.waitForEvent("websocket", { predicate: ws => new URL(ws.url()).searchParams.get("session") === "prompt-project" });
  await action.click();
  await socket;
  await expect(page.locator("#terminal-view")).toBeVisible();
});

test("row context: project and remote machine stay visible on next and today", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").identity.projectPath = "/work/focus-ui";
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions.find((i: { id: string }) => i.id === "leak").project = "/work/broker";
    body.document.intentions.find((i: { id: string }) => i.id === "leak").machine = "remote-box";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("summary .focus-for")).toHaveText("focus-ui");
  await expect(block.locator(".focus-next li").filter({ hasText: "fix broker leak" }).locator("summary .focus-for")).toHaveText("broker · remote-box");
  for (const context of await block.locator("summary .focus-for").all()) await expect(context).toBeVisible();
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-today li").filter({ hasText: "fix broker leak" }).locator("summary .focus-for")).toHaveText("broker · remote-box");
  await expect(view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" }).locator("summary .focus-for")).toContainText("focus-ui");
  for (const context of await view.locator("summary .focus-for").all()) await expect(context).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 390) {
    for (const summary of await view.locator(".focus-next summary, .focus-today summary").all()) {
      const context = summary.locator(".focus-for");
      if (await context.count()) expect(await context.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(await summary.locator(".focus-title").evaluate(el => el.getBoundingClientRect().top));
    }
  }
  if (process.env.WOLFPACK_FOCUS_SHOTS) {
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-context-${width}.png`), fullPage: true });
  }
});

test("counts: validated needs-you population and uncapped next totals agree", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    body.sessions.push(...Array.from({ length: 8 }, (_, index) => ({ ...template, name: `count-${index}`,
      identity: { ...template.identity, wolfpackSessionId: `mock:count-${index}` },
      runtimeState: { ...template.runtimeState, state: index === 7 ? "failed" : "needs-input", stale: index === 6,
        freshness: index === 6 ? "stale" : "fresh", changedAt: index === 6 ? "2020-01-01T00:00:00Z" : new Date().toISOString() },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="need"] .n')).toHaveAttribute("data-count", "7");
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="fail"] .n')).toHaveAttribute("data-count", "1");
  await expect(page.locator("#assistant-content .focus-next")).not.toContainText("count-6");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("8 next:");
  await expect(page.locator("#dashboard-focus > small").last()).toContainText("8 next");
  await expect(page.locator("#dashboard-focus .focus-next > li")).toHaveCount(3);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content > h2").first()).toHaveText("next 8");
  await expect(page.locator("#assistant-content .focus-next > li")).toHaveCount(5);
});

test("many stops: twelve unseen episodes remain capped without an hours cutoff", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const names = Array.from({ length: 12 }, (_, i) => `review-${String(i + 1).padStart(2, "0")}`);
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...names.map((name, i) => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}`, projectPath: `/work/research-${i % 3 + 1}` },
      runtimeState: { ...template.runtimeState, state: i % 2 ? "idle" : "done", unseen: true, stoppedSequence: 5,
        acknowledgedSequence: 0, changedAt: new Date(Date.now() - (i + 2) * 864e5).toISOString() },
    }))];
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [{ id: "stops", title: "Review stopped research", createdAt: new Date().toISOString(), done: false, sessions: names.map(n => `mock:${n}`) }];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  await expect(block.locator(".focus-next .focus-title").first()).toContainText("review-12 stopped · 13d");
  const shots = process.env.WOLFPACK_FOCUS_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `old-stops-dashboard-${width}.png`), fullPage: true });
  }
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next > li")).toHaveCount(5);
  await expect(view.locator(".focus-next > li:visible")).toHaveCount(width === 390 ? 3 : 5);
  await expect(view.locator(".focus-next .focus-title").first()).toContainText("review-12 stopped · 13d");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: join(shots, `old-stops-assistant-${width}.png`), fullPage: true });
});
