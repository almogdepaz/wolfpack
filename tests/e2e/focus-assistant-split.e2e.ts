import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function open(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
function sockets(page: Page) {
  const sessions: string[] = [];
  page.on("websocket", ws => { const url = new URL(ws.url()); if (url.pathname === "/ws/pty") sessions.push(url.searchParams.get("session")!); });
  return sessions;
}

test("proven helpers are excluded, but a pinned namesake in another folder remains a card and ranks", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), body = await response.json();
    const namesake = body.sessions.find((s: { name: string }) => s.name === "assistant-chat");
    namesake.identity = { ...namesake.identity, projectPath: "/work/ordinary", agentKind: "shell" };
    delete namesake.focusAssistant;
    namesake.runtimeState = { ...namesake.runtimeState, state: "needs-input", inputKind: "question" };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-summary")).toContainText("5 sessions");
  await expect(page.locator("#session-list .card-name-text").filter({ hasText: /^assistant-chat$/ }).first()).toBeVisible();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-next > li").filter({ hasText: "assistant-chat" })).toBeVisible();
  await expect(page.locator("#session-list .card-name-text").filter({ hasText: /^assistant$/ })).toHaveCount(0);
});

test("talk and take-reply attach chat, never the worker", async ({ page }) => {
  const opened = sockets(page);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(), body = await response.json();
    body.document.next = { author: "assistant", updatedAt: new Date().toISOString(), rows: [], take: { text: "Which priority should come first?", about: [] } };
    await route.fulfill({ response, json: body });
  });
  await open(page);
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect.poll(() => opened.at(-1)).toBe("assistant-chat");
  if (page.viewportSize()!.width >= 1280) await page.getByRole("button", { name: "Hide assistant terminal", exact: true }).click();
  else await page.locator("#assistant-terminal-focus").click();
  await page.getByRole("button", { name: "Reply to assistant", exact: true }).click();
  await expect.poll(() => opened.length).toBe(2);
  expect(opened).toEqual(["assistant-chat", "assistant-chat"]);
});

test("plan pastes only into chat while the worker is busy or waiting on a dialog", async ({ page }) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(), body = await response.json();
    body.assistant.state = "needs-input";
    body.assistant.chat.state = "working";
    await route.fulfill({ response, json: body });
  });
  const sends: unknown[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().postDataJSON()); await route.fulfill({ json: { outcome: "delivered" } }); });
  await open(page);
  const plan = page.locator('#assistant-content [data-focus-plan="leak"]');
  await expect(plan).toBeEnabled();
  await plan.click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ session: "assistant-chat", noEnter: true });
});

for (const role of ["assistant", "assistant-chat"]) test(`needs-you opens the ${role} dialog; either role's dialog turns the dot amber`, async ({ page }) => {
  const opened = sockets(page);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(), body = await response.json();
    body.assistant.state = role === "assistant" ? "needs-input" : "working";
    body.assistant.chat.state = role === "assistant-chat" ? "needs-input" : "done";
    await route.fulfill({ response, json: body });
  });
  await open(page);
  // User decision (2026-11-16): a chat dialog is the user's move too, so the dot is amber for either role.
  await expect(page.locator("#assistant-content .focus-header .dot")).toHaveClass(/yellow/);
  await page.locator("#assistant-content .focus-header").getByRole("button", { name: "assistant needs you ›", exact: true }).click();
  await expect.poll(() => opened.at(-1)).toBe(role);
});

test("a routine arriving during an attached chat is submitted only to the worker", async ({ page }) => {
  const isolated = await startTestServer({ focusAssistant: true, focusRoutine: true });
  const opened = sockets(page);
  const root = join(isolated.home, ".wolfpack/assistant");
  const log = join(isolated.home, ".wolfpack/focus-sends.jsonl");
  const submissions = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string; text: string }).filter(row => row.text.includes("process inbox ")) : [];
  try {
    await page.goto(isolated.baseUrl);
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
    await expect.poll(() => opened.at(-1)).toBe("assistant-chat");
    await expect.poll(() => existsSync(join(root, "routines.json"))).toBe(true);
    const coverage = JSON.parse(readFileSync(join(root, "routines.json"), "utf8"));
    if (coverage.inbox) expect((await page.request.post(`${isolated.baseUrl}/api/activity/ack`, { data: { file: coverage.inbox.file } })).ok()).toBe(true);
    // Real user input presence on an ordinary work session supplies new journal activity.
    await page.request.post(`${isolated.baseUrl}/api/session-control/send`, { data: { session: "prompt-project", text: "continue the current task", noEnter: true } });
    const before = submissions().length;
    expect((await page.request.post(`${isolated.baseUrl}/api/focus/catch-up`)).ok()).toBe(true);
    await expect.poll(() => submissions().length).toBeGreaterThan(before);
    expect(submissions().slice(before).map(row => row.id)).toEqual(["mock:assistant"]);
    expect(opened).toEqual(["assistant-chat"]);
    await expect(page.locator(page.viewportSize()!.width >= 1280 ? "#assistant-pane canvas" : "#desktop-terminal-container canvas").first()).toBeVisible();
  } finally { await isolated.close(); }
});

test("settings exposes both states and a background inspection terminal without retargeting talk", async ({ page }) => {
  const opened = sockets(page);
  await open(page);
  await page.locator("#assistant-content").getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).toContainText("background");
  await expect(page.locator("#assistant-setting-status")).toContainText("chat");
  await page.getByRole("button", { name: "Inspect background terminal", exact: true }).click();
  await expect.poll(() => opened.at(-1)).toBe("assistant");
  if (page.viewportSize()!.width >= 1280) await page.getByRole("button", { name: "Hide assistant terminal", exact: true }).click();
  else await page.locator("#assistant-terminal-focus").click();
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect.poll(() => opened.at(-1)).toBe("assistant-chat");
});
