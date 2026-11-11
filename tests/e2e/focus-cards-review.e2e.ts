import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
const episode = "2026-11-11T10:00:00Z";
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
async function next(page: Page, suggestion?: string) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const rows = suggestion === undefined ? [] : [{ ref: { machine: current.installationId, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "suggest", reason: "review probe suggestion", suggestion }];
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "next", author: "assistant", rows }] } })).ok()).toBe(true);
}
async function fixedEpisode(page: Page) {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.runtimeState = { ...s.runtimeState, state: "needs-input", inputKind: "question", changedAt: episode, stoppedAt: episode };
    await route.fulfill({ response, json: body });
  });
}
test("R1: free reply receipt must not alias literal suggestion reply", async ({ page }) => {
  await next(page); await fixedEpisode(page);
  let sends = 0;
  await page.route("**/api/session-control/send", async route => { sends++; await route.fulfill({ json: { outcome: "submitted" } }); });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "prompt-project" });
  await expandFocusCard(row);
  await row.getByRole("textbox").fill("previous free-text message");
  await row.getByRole("button", { name: "Send to prompt-project", exact: true }).click();
  await expect(row.locator("[role=status]")).toContainText("sent to prompt-project");
  await next(page, "reply"); await page.reload(); await expandFocusCard(row);
  await expect(row.getByRole("textbox")).toHaveValue("reply");
  await expect(row.getByRole("textbox")).not.toBeEditable();
  await expect(row.getByRole("button", { name: "Send to prompt-project", exact: true })).toHaveCount(0);
  expect(sends).toBe(1);
});
for (const fallback of ["removed", "expired"] as const) test(`R2: uncertain suggestion retains its duplicate fence when triage is ${fallback}`, async ({ page }) => {
  await next(page, "Continue with the plan"); await fixedEpisode(page);
  const sends: unknown[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().postDataJSON()); await route.fulfill({ json: { outcome: "unverified" } }); });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "prompt-project" });
  await expandFocusCard(row);
  await row.getByRole("button", { name: "Send to prompt-project", exact: true }).click();
  await expect(row.locator("[role=status]")).toContainText("delivery unconfirmed");
  if (fallback === "removed") await next(page);
  else await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json(); delete body.routines;
    body.document.next.updatedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    await route.fulfill({ response, json: body });
  });
  await page.reload(); await expandFocusCard(row);
  const box = row.getByRole("textbox");
  // Retain the reviewer's actual double-send attempt, not just a disabled-state assertion.
  if (await box.isEditable()) {
    await box.fill("Continue with the plan");
    await row.getByRole("button", { name: "Send to prompt-project", exact: true }).click();
    await expect.poll(() => sends.length).toBe(2);
  }
  expect(sends).toHaveLength(1);
  await expect(box).not.toBeEditable();
});
