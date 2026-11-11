import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
const episode = "2026-11-09T12:00:00.000Z";
const text = "Choose the plan first; the release depends on that choice.";
const shots = join(homedir(), ".cache/focus-take-shots");
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); mkdirSync(shots, { recursive: true }); });
test.afterAll(async () => { await server?.close(); });
async function write(page: Page, ops: unknown[]) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const response = await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function setup(page: Page) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const rows = [
    { ref: { machine: current.installationId, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "needs-you", reason: "Choose the dependency plan" },
    { ref: { intentionId: "release" }, verdict: "needs-you", reason: "Choose the release date" },
  ];
  const op = { type: "next", rows, author: "assistant", take: { text, about: rows.map(r => r.ref) } };
  await write(page, [
    ...current.document.intentions.map((i: { id: string }) => ({ type: "drop", id: i.id })),
    { type: "add", intention: { id: "release", title: "Ship the release" } }, op,
  ]);
  const state = { answered: false, offline: false };
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (state.offline) return route.abort();
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); const body = await response.json();
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => ["assistant", "prompt-project"].includes(s.name));
    for (const s of body.sessions) if (s.name === "prompt-project") s.runtimeState = { ...s.runtimeState,
      state: state.answered ? "working" : "needs-input", inputKind: "question", changedAt: episode, stoppedAt: episode,
      unseen: true, stoppedSequence: 5, acknowledgedSequence: 0, stale: false, freshness: "fresh" };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
    localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1");
  });
  return { op, state };
}
const refresh = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

test("take sits below cards on both hosts; dismissal persists and a newer order returns until an about card resolves", async ({ page }, info) => {
  const { op, state } = await setup(page);
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const view = page.locator("#assistant-content");
  const take = block.locator(".focus-take");
  await expect(block.locator(".focus-next > li")).toHaveCount(2);
  await expect(take).toContainText(text);
  await expect(take.locator(".focus-take-label")).toHaveText(/assistant's take · (now|\d+m) ago/);
  await expect.poll(() => take.evaluate(el => el.previousElementSibling?.className)).toBe("focus-quiet");
  await expect.poll(() => take.evaluate(el => el.nextElementSibling?.tagName)).toBe("SMALL");
  await take.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, `${info.project.name}-dashboard-visible.png`), fullPage: true });
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const pageTake = view.locator(".focus-take");
  await expect(pageTake).toContainText(text);
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await expect.poll(() => pageTake.evaluate(el => el.nextElementSibling?.tagName)).toBe("DETAILS");
  await expect(pageTake).toHaveCSS("font-size", "13px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === "iphone-14") {
    const label = await pageTake.locator(".focus-take-label").boundingBox();
    const buttons = await pageTake.getByRole("button").all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y).toBeGreaterThan(label!.y + label!.height);
    }
  }
  await page.screenshot({ path: join(shots, `${info.project.name}-page-visible.png`), fullPage: true });
  await pageTake.getByRole("button", { name: "Got it: dismiss the assistant's take", exact: true }).click();
  await expect(pageTake).toHaveCount(0);
  await expect(take).toHaveCount(0);
  const saved = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(saved.document.seenTakeAt).toBe(saved.document.next.updatedAt);
  await page.reload();
  await expect(block).toBeVisible();
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(view.locator(".focus-header")).toBeVisible();
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await expect(pageTake).toHaveCount(0);
  await page.screenshot({ path: join(shots, `${info.project.name}-dismissed.png`), fullPage: true });
  await write(page, [op]);
  await refresh(page);
  await expect(pageTake).toContainText(text);
  await pageTake.getByRole("button", { name: "Reply to assistant", exact: true }).click();
  if (info.project.name === "desktop") await expect(page.locator("#assistant-pane")).toBeVisible();
  else {
    await expect(page.locator("#terminal-view")).toBeVisible();
    await page.locator("#assistant-terminal-focus").click();
    await expect(page.locator("#assistant-view")).toHaveClass(/visible/);
  }
  state.answered = true;
  await refresh(page);
  await expect(view.locator(".focus-next > li")).toHaveCount(1);
  await expect(pageTake).toHaveCount(0);
});

test("cached offline take cannot be dismissed or sent, and a new order without a take removes it", async ({ page }) => {
  const { state, op } = await setup(page);
  await page.goto(server.baseUrl);
  const take = page.locator("#dashboard-focus .focus-take");
  await expect(take).toContainText(text);
  state.offline = true;
  await refresh(page);
  await expect(take.getByRole("button", { name: "Got it: dismiss the assistant's take", exact: true })).toBeDisabled();
  await expect(take.getByRole("button", { name: "Reply to assistant", exact: true })).toBeDisabled();
  state.offline = false;
  const { take: _take, ...without } = op;
  await write(page, [without]);
  await refresh(page);
  await expect(take).toHaveCount(0);
});
