import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import type { FocusDocument, FocusOp } from "../../src/focus-contract";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
const title = 'review “release” & ship';
const target = { id: "target", title, project: "/work/release", machine: "sgt", sessions: ["mock:prompt-project", "mock:another-project"] };
async function document(page: Page): Promise<FocusDocument> {
  return (await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).document;
}
async function update(page: Page, ops: FocusOp[]) {
  const current = await document(page);
  const response = await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops } });
  expect(await response.json()).not.toHaveProperty("error");
  expect(response.ok()).toBe(true);
}
async function open(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
const status = (page: Page) => page.locator("#assistant-content").getByRole("status").filter({ hasText: `removed “${title}”` });
const removalUndo = (page: Page) => status(page).getByRole("button", { name: "undo", exact: true });
async function removeTarget(page: Page) {
  const card = page.locator('#assistant-content [data-focus-card="intention:target"]');
  await card.locator("summary").click();
  const remove = card.getByRole("button", { name: `Remove: ${title}`, exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(status(page)).toHaveText(`removed “${title}” · undo`);
  await expect(removalUndo(page)).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1"));
  const current = await document(page);
  await update(page, [
    ...current.intentions.map(i => ({ type: "drop" as const, id: i.id })),
    { type: "add", intention: { id: "first", title: "first task" } },
    { type: "add", intention: target },
    { type: "add", intention: { id: "last", title: "last task" } },
    { type: "add", intention: { id: "finished", title: "finished task" } },
    { type: "add", intention: { id: "older", title: "older task", sessions: ["mock:prompt-project"] } },
    { type: "done", id: "finished" }, { type: "done", id: "older" },
  ]);
});

test("today excludes every earlier-day completion, even with linked work finishing today", async ({ page }) => {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  await update(page, [{ type: "add", intention: { id: "legacy", title: "undated finished task" } }, { type: "done", id: "legacy" }]);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions.find((i: { id: string }) => i.id === "older").doneAt = yesterday.toISOString();
    delete body.document.intentions.find((i: { id: string }) => i.id === "legacy").doneAt;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.runtimeState = { ...session.runtimeState, state: "done", changedAt: new Date().toISOString(), unseen: false, stoppedSequence: 5, acknowledgedSequence: 5 };
    await route.fulfill({ response, json: body });
  });
  await open(page);
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-today > li")).toHaveCount(3);
  await expect(view).not.toContainText("older task");
  await expect(view).not.toContainText("undated finished task");
  await expect(view.getByRole("heading", { name: "today 1 of 4 done", exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "Undo done: finished task", exact: true })).toBeVisible();
  await expect(view.getByText("reorder or reword: tell the assistant", { exact: true })).toBeVisible();
});

test("remove + undo restores the old index against latest ids, project and sessions without touching sessions", async ({ page }, info) => {
  const before = (await (await page.request.get(`${server.baseUrl}/api/sessions`)).json()).sessions;
  await open(page);
  await removeTarget(page);
  expect((await document(page)).intentions.some(i => i.id === "target")).toBe(false);
  await update(page, [{ type: "add", intention: { id: "concurrent", title: "new task" } }, { type: "reorder", ids: ["last", "first", "finished", "older", "concurrent"] }]);
  await removalUndo(page).click();
  await expect.poll(async () => (await document(page)).intentions.map(i => i.id)).toEqual(["last", "target", "first", "finished", "older", "concurrent"]);
  const saved = (await document(page)).intentions.find(i => i.id === "target")!;
  expect(saved).toMatchObject(target);
  expect(saved.done).not.toBe(true);
  await expect(page.getByRole("checkbox", { name: `Done: ${title}`, exact: true })).toBeFocused();
  const after = (await (await page.request.get(`${server.baseUrl}/api/sessions`)).json()).sessions;
  expect(after.map((s: { name: string }) => s.name)).toEqual(before.map((s: { name: string }) => s.name));
  await expect(status(page)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("cleanup-restored.png"), fullPage: true });
});

test("finished remove + undo restores done in one batch and focuses its done undo", async ({ page }, info) => {
  const original = (await document(page)).intentions.find(i => i.id === "finished")!;
  await open(page);
  await page.locator("#assistant-content").getByRole("button", { name: "Remove: finished task", exact: true }).click();
  const line = page.locator("#assistant-content").getByRole("status").filter({ hasText: "removed “finished task”" });
  await expect(line.getByRole("button", { name: "undo", exact: true })).toBeFocused();
  expect((await document(page)).intentions.some(i => i.id === "finished")).toBe(false);
  await page.screenshot({ path: info.outputPath("cleanup-removed.png"), fullPage: true });
  const request = page.waitForRequest(req => req.method() === "POST" && req.url().endsWith("/api/focus"));
  await line.getByRole("button", { name: "undo", exact: true }).click();
  expect((await request).postDataJSON().ops.map((op: FocusOp) => op.type)).toEqual(["add", "reorder", "done"]);
  await expect(page.getByRole("button", { name: "Undo done: finished task", exact: true })).toBeFocused();
  const restored = (await document(page)).intentions.find(i => i.id === "finished")!;
  expect(restored.done).toBe(true);
  expect(Date.parse(restored.doneAt!)).toBeGreaterThanOrEqual(Date.parse(original.doneAt!));
  await expect(page.locator('#assistant-content [data-focus-card="intention:finished"]')).toHaveCount(0);
});

test("a concurrently re-added id is not overwritten and reports the normal action error", async ({ page }) => {
  await open(page);
  await removeTarget(page);
  await update(page, [{ type: "add", intention: { id: "target", title: "another device restored this" } }]);
  await removalUndo(page).click();
  await expect(page.locator("#focus-status")).toContainText("duplicate intention id");
  expect((await document(page)).intentions.find(i => i.id === "target")?.title).toBe("another device restored this");
});

test("remove and undo controls lock during a write, and repeated CAS conflicts keep the removal recoverable", async ({ page }) => {
  await open(page);
  await removeTarget(page);
  let attempts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const request = route.request();
    if (request.method() === "POST" && request.postDataJSON().ops.some((op: FocusOp) => op.type === "add")) {
      if (++attempts === 1) await held;
      await route.fulfill({ status: 409, json: { error: "fixture conflict; review the current focus" } });
    } else await route.continue();
  });
  await removalUndo(page).click();
  try {
    await expect.poll(() => attempts).toBe(1);
    await page.evaluate(() => window.document.dispatchEvent(new Event("visibilitychange")));
    await expect(removalUndo(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove: finished task", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.locator("#focus-status")).toContainText("fixture conflict");
  expect(attempts).toBe(2);
  await expect(removalUndo(page)).toBeEnabled();
  expect((await document(page)).intentions.some(i => i.id === "target")).toBe(false);
});

test("a rejected removal leaves the intention and exposes the action error, not an undo receipt", async ({ page }) => {
  await open(page);
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() === "POST") await route.fulfill({ status: 400, json: { error: "fixture removal rejected" } });
    else await route.continue();
  });
  const card = page.locator('#assistant-content [data-focus-card="intention:target"]');
  await card.locator("summary").click();
  await card.getByRole("button", { name: `Remove: ${title}`, exact: true }).click();
  await expect(page.locator("#focus-status")).toHaveText("fixture removal rejected");
  await expect(status(page)).toHaveCount(0);
  expect((await document(page)).intentions.find(i => i.id === "target")).toMatchObject(target);
});

test("removal undo expires after ten seconds without trapping keyboard focus", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await removeTarget(page);
  await page.clock.fastForward(10_001);
  await expect(status(page)).toHaveCount(0);
  await expect(page.locator(".assistant-column")).toBeFocused();
  expect((await document(page)).intentions.some(i => i.id === "target")).toBe(false);
});

test("historical-only documents have no today header or empty disclosure and retain the add form", async ({ page }) => {
  await update(page, ["first", "target", "last", "finished"].map(id => ({ type: "drop" as const, id })));
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions[0].doneAt = new Date(Date.now() - 864e5).toISOString();
    await route.fulfill({ response, json: body });
  });
  await open(page);
  await expect(page.locator("#assistant-content .focus-today")).toHaveCount(0);
  await expect(page.locator("#assistant-content .focus-done")).toHaveCount(0);
  await expect(page.locator("#assistant-content").getByText("why this order", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Add an intention", exact: true })).toBeVisible();
  await expect(page.locator("#dashboard-focus-details > small").last()).not.toContainText("today");
});
