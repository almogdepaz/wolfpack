import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const outcome of ["submitted", "unverified", "not_delivered"] as const) test(`empty-box reply sends exact text and fences its episode: ${outcome}`, async ({ page }) => {
  let episode = "2026-11-11T10:00:00Z";
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.runtimeState = { ...session.runtimeState, changedAt: episode, stoppedAt: episode, inputKind: "question" };
    await route.fulfill({ response, json: body });
  });
  const sends: { text: string; session: string; ensureSubmitted: boolean }[] = [];
  await page.route("**/api/session-control/send", async route => {
    sends.push(route.request().postDataJSON()); await route.fulfill({ json: { outcome } });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "prompt-project" });
  await expandFocusCard(row);
  const reply = row.getByRole("textbox", { name: "reply to prompt-project", exact: true });
  const send = row.getByRole("button", { name: "Send to prompt-project", exact: true });
  await expect(reply).toHaveValue("");
  await expect(reply).toHaveAttribute("placeholder", "reply to prompt-project…");
  await expect(send).toBeDisabled();
  await reply.fill("  /review my exact reply  ");
  await expect(send).toBeEnabled();
  await expect(row.getByRole("button", { name: "reset", exact: true })).toHaveCount(0);
  await send.click();
  await expect(row.locator("[role=status]")).toBeVisible();
  expect(sends).toEqual([{ session: "mock:prompt-project", text: "  /review my exact reply  ", ensureSubmitted: true }]);
  if (outcome === "not_delivered") {
    await expect(reply).toBeEditable();
    await expect(send).toHaveText("retry send to prompt-project ›");
    await reply.fill("retry safely"); await send.click();
    await expect.poll(() => sends.length).toBe(2);
    return;
  }
  await expect(reply).not.toBeEditable();
  await expect(send).toHaveCount(0);
  await page.reload(); await expandFocusCard(row);
  await expect(reply).toHaveValue("  /review my exact reply  ");
  await expect(reply).not.toBeEditable();
  await expect(send).toHaveCount(0);
  expect(sends).toHaveLength(1);
  episode = "2026-11-11T10:01:00Z";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reply).toBeEditable();
  await expect(reply).toHaveValue("");
});

for (const inputKind of ["permission", "auth"] as const) test(`${inputKind} without a suggestion has no reply box`, async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").runtimeState.inputKind = inputKind;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "prompt-project" });
  await expandFocusCard(row);
  await expect(row.locator("textarea")).toHaveCount(0);
  await expect(row).toContainText("answer in the terminal");
  await expect(row.getByRole("button", { name: "Open prompt-project", exact: true })).toBeEnabled();
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
});
