import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";
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
  // the next-row card for the same session is a separate card on this page; both stay open across a poll
  await view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator(".focus-card > summary").click();
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  await page.waitForTimeout(6000);
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  await linked.locator(".focus-chips").getByRole("button", { name: "another-project" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

// Agent-context v3 fixture shaped by .plans/focus-cards-ref/context.schema.json.
const SESSION_UUID = "3f1c2a9e-7b4d-4e21-9c0a-5d6e7f8a9b0c";
const item = (id: string, text: string) => ({ id, text });
const v3 = {
  schemaVersion: 3,
  goal: "Ship the focus cards round",
  now: { id: "cards", text: "Wire the context block into session cards", details: "So the dashboard answers what each agent is doing." },
  needsYou: [item("approve-copy", "Approve the <img src=x onerror=alert(1)> state copy"), ...["a", "b", "c", "d", "e", "f"].map(k => item(`q-${k}`, `question ${k}`))],
  needToKnow: [item("bundle", "Bundle cap is a loose guard"), item("local", "Changes are local"), item("pi", "pi 1.3.0 here"), item("hidden", "fourth fact stays out")],
  nextSteps: [{ id: "test", text: "Run the e2e", owner: "agent" }, { id: "look", text: "Look at the captures", owner: "user" }],
  history: [{ id: "h1", text: "Cards over a drawer", kind: "decision" }],
  source: { harness: "pi", sessionId: "pi-session", branchId: null, coveredEntryId: null },
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  freshness: "reviewed",
  activity: { state: "working", observedAt: new Date().toISOString() },
};
async function withContext(page: import("@playwright/test").Page, document: unknown) {
  const reads: string[] = [];
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").identity.wolfpackSessionId = SESSION_UUID;
    await route.fulfill({ response, json: body });
  });
  // a valid catalog (the app's extension host parses it too); no `ui`, so nothing tries to load an asset
  const installation = (extensionId: string, documents: { id: string; schemaVersion: number }[]) => ({ installationId: "6d2f8c1e-4a3b-4c5d-8e9f-0a1b2c3d4e5f", extensionId, enabled: true, package: { name: `wolfpack-extension-${extensionId}`, version: "0.1.0", digest: "a".repeat(64) }, blobs: null, documents });
  await page.route(url => url.pathname === "/api/extensions", route => route.fulfill({ json: { safeMode: false, installations: [installation("changes", []), installation("agent-context", [{ id: "context", schemaVersion: 3 }])] } }));
  await page.route(url => url.pathname === "/api/extensions/documents/agent-context/context", route => {
    reads.push(new URL(route.request().url()).searchParams.get("session") ?? "");
    return route.fulfill({ json: { installationId: "i", scopeSessionId: SESSION_UUID, extensionId: "agent-context", documentId: "context", revision: document ? 3 : 0, document } });
  });
  return reads;
}

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
