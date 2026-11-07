import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer();
  mkdirSync(join(server.home, ".wolfpack"), { recursive: true });
  writeFileSync(join(server.home, ".wolfpack/config.json"), JSON.stringify({ devDir: "/tmp", port: server.port }));
});
test.afterAll(async () => { await server?.close(); });
const settingsButton = (project: string) => project === "desktop" ? "#expanded-settings-btn" : "#mobile-settings";
async function withBlockedPromptProject(page: Page) {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.runtimeState = { ...session.runtimeState, state: "needs-input", authority: "program", stale: false };
    await route.fulfill({ response, json: body });
  });
}

test("with the assistant off nothing of the focus ui shows; settings is the only door", async ({ page }, info) => {
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list .card").first()).toBeVisible();
  await expect(page.locator("#dashboard-focus")).toBeHidden();
  await expect(page.locator("#sidebar-assistant")).toBeHidden();
  // views are moved off-screen, not display:none; the page must be neither shown nor rendered
  await expect(page.locator("#assistant-view")).not.toHaveClass(/visible/);
  await expect(page.locator("#assistant-content")).toBeEmpty();
  await expect(page.getByRole("button", { name: /open assistant/i })).toHaveCount(0);
  await page.locator(settingsButton(info.project.name)).click();
  const section = page.locator("#settings-assistant");
  await expect(section.locator("#assistant-setting-status")).toHaveText("off");
  await expect(section.getByRole("button", { name: /enable assistant/i })).toHaveCount(1);
  await expect(section.locator("#assistant-setting-open")).toBeHidden();
  expect((await new AxeBuilder({ page }).include("#settings-assistant").analyze()).violations).toEqual([]);
});

test("enabling is one button and one dialog; the assistant then opens for its first run", async ({ page }, info) => {
  await withBlockedPromptProject(page);
  await page.goto(server.baseUrl);
  await page.locator(settingsButton(info.project.name)).click();
  await page.locator("#settings-assistant").getByRole("button", { name: /enable assistant/i }).click();
  const dialog = page.locator("#app-dialog");
  await expect(dialog.locator("#app-dialog-title")).toHaveText("Enable assistant");
  await expect(dialog.locator("#app-dialog-confirm")).toHaveText("Enable");
  await dialog.locator("#app-dialog-confirm").click();
  const view = page.locator("#assistant-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("button", { name: /enable assistant/i })).toHaveCount(0);
  const first = view.getByRole("textbox", { name: "What are you working on?" });
  await expect(first).toBeVisible();
  await first.fill("ship focus");
  await first.press("Enter");
  await expect(view.getByRole("button", { name: /start.*ship focus/i })).toBeVisible();
  await view.getByRole("textbox", { name: "Add an intention" }).fill("reply to issue");
  await view.getByRole("textbox", { name: "Add an intention" }).press("Enter");
  await view.getByRole("checkbox", { name: "Done: reply to issue" }).check();
  await expect(view).toContainText("1 of 2 done");
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toBeVisible();
  await expect(block.getByRole("button", { name: /start.*ship focus/i })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await block.getByRole("button", { name: /prompt-project/ }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  if (info.project.name === "desktop") await expect(page.locator("#sidebar-assistant")).toBeVisible();
  if (info.project.name === "desktop") {
    await page.locator("#sidebar-assistant").click();
    await expect(page.locator("#assistant-view")).toBeVisible();
  }
});

test("cached home-offline focus is read-only and still ranks live sessions", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus .focus-next")).toBeVisible();
  await page.route(url => url.pathname === "/api/focus", route => route.abort("failed"));
  await page.reload();
  await expect(page.locator("#dashboard-focus")).toContainText("offline");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Add an intention" })).toBeDisabled();
  await expect(page.locator("#assistant-content .focus-next")).toBeVisible();
});

test("talk opens the assistant terminal, Focus returns, a busy ask is queued, and the terminal header can disable it", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.locator("#assistant-view").getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#assistant-terminal-focus")).toBeVisible();
  await page.locator("#assistant-terminal-focus").click();
  await page.getByRole("textbox", { name: "Ask the assistant" }).fill("move ship focus first");
  await page.getByRole("textbox", { name: "Ask the assistant" }).press("Enter");
  await expect(page.locator("#assistant-terminal-state")).toContainText("queued");
  await page.locator("#assistant-terminal-stop").click();
  await page.locator("#app-dialog-confirm").click();
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).assistant.enabled).toBe(false);
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list .card").first()).toBeVisible();
  await expect(page.locator("#dashboard-focus")).toBeHidden();
});
