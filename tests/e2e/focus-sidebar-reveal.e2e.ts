import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

// prompt-project (needs you, first next row) becomes a child agent of test-project, which starts collapsed in every session list.
async function nestPromptProject(page: Page): Promise<void> {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const parent = body.sessions.find((s: { name: string }) => s.name === "test-project");
    const child = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    child.identity.parentSession = { wolfpackSessionId: parent.identity.wolfpackSessionId, wolfpackSessionName: parent.name };
    await route.fulfill({ response, json: body });
  });
}

test("opening a child agent from a next row expands its parent in the sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the sidebar is a desktop surface");
  await nestPromptProject(page);
  await page.goto(server.baseUrl);
  const list = page.locator("#session-list");
  await expect(list.locator(".delegation-parent-card", { hasText: "test-project" })).toBeVisible();
  await expect(list.locator(".sub-session-card")).toHaveCount(0);
  await page.locator("#dashboard-focus .focus-next li").filter({ hasText: "prompt-project" }).getByRole("button", { name: /prompt-project/ }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  const sidebar = page.locator("#sidebar-session-list");
  await expect(sidebar.locator(".sub-session-card", { hasText: "prompt-project" })).toBeVisible();
  await expect(sidebar.locator(".delegation-sidebar-toggle[aria-expanded='true']")).toHaveCount(1);
});

test("on a phone the session list shows the opened child agent when the user comes back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone list behaviour");
  await nestPromptProject(page);
  await page.goto(server.baseUrl);
  const list = page.locator("#session-list");
  await expect(list.locator(".delegation-parent-card", { hasText: "test-project" })).toBeVisible();
  await expect(list.locator(".sub-session-card")).toHaveCount(0);
  await page.locator("#dashboard-focus .focus-next li").filter({ hasText: "prompt-project" }).getByRole("button", { name: /prompt-project/ }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await page.locator("#back-btn").click();
  await expect(list.locator(".sub-session-card", { hasText: "prompt-project" })).toBeVisible();
});
