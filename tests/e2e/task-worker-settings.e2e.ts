import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openSettingsFromUi, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
let policyPath: string;

async function openTaskWorkerSettings(page: Page): Promise<void> {
  await openSettingsFromUi(page);
  const agentsSection = page.getByRole("link", { name: "Agents" });
  if (await agentsSection.isVisible()) await agentsSection.click();
  await expect(page.getByLabel("Task worker extension discovery")).toBeVisible();
}

async function returnAndReopenTaskWorkerSettings(page: Page): Promise<void> {
  const desktopBack = page.locator("#settings-back-btn");
  if (await desktopBack.boundingBox()) await desktopBack.click();
  else await page.locator("#back-btn").click();
  const expandedSettings = page.locator("#expanded-settings-btn");
  if (await expandedSettings.boundingBox()) await expandedSettings.click();
  else await page.locator("#gear-btn").click();
  const agentsSection = page.getByRole("link", { name: "Agents" });
  if (await agentsSection.isVisible()) await agentsSection.click();
  await expect(page.getByLabel("Task worker extension discovery")).toBeVisible();
}

test.beforeAll(async () => {
  server = await startTestServer();
  policyPath = join(server.home, ".wolfpack", "task-worker-policy.json");
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  rmSync(policyPath, { force: true });
  await page.goto(server.baseUrl);
  await expect(page.locator(".card").first()).toBeVisible({ timeout: 15_000 });
});

test("task worker extension discovery persists an accessible confirmed server value", async ({ page }) => {
  await openTaskWorkerSettings(page);

  const control = page.getByLabel("Task worker extension discovery");
  const status = page.locator("#task-worker-extension-policy-status");
  await expect(control).toHaveValue("inherit");
  await expect(status).toContainText("new task workers only");
  await expect(page.getByText("mandatory Pi Tasks and explicitly configured optional files remain loaded")).toBeVisible();

  let releaseSave: (() => void) | undefined;
  let saveIntercepted: (() => void) | undefined;
  const saveStarted = new Promise<void>((resolve) => { saveIntercepted = resolve; });
  await page.route("**/api/task-worker-settings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    saveIntercepted?.();
    await new Promise<void>((resolve) => { releaseSave = resolve; });
    await route.continue();
  });

  await control.focus();
  await expect(control).toBeFocused();
  await control.selectOption("isolated");
  await saveStarted;
  await expect(status).toContainText("Saving host-wide task-worker extension discovery");
  releaseSave?.();
  await expect(status).toContainText("saved");
  await expect(control).toHaveValue("isolated");

  await page.goto(`${server.baseUrl}?task-worker-settings-reload#settings-agents`);
  await expect(control).toHaveValue("isolated");
  await expect(status).toContainText("new task workers only");
});

test("task worker extension discovery does not start a second load while the first is pending", async ({ page }) => {
  let releaseFirstGet: (() => void) | undefined;
  let firstGetStarted: (() => void) | undefined;
  let getRequests = 0;
  const firstGet = new Promise<void>((resolve) => { firstGetStarted = resolve; });
  await page.route("**/api/task-worker-settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    getRequests += 1;
    if (getRequests === 1) {
      firstGetStarted?.();
      await new Promise<void>((resolve) => { releaseFirstGet = resolve; });
    }
    await route.continue();
  });

  await openTaskWorkerSettings(page);
  const control = page.getByLabel("Task worker extension discovery");
  const status = page.locator("#task-worker-extension-policy-status");
  await firstGet;
  await expect(control).toBeDisabled();

  await returnAndReopenTaskWorkerSettings(page);
  await expect.poll(() => getRequests).toBe(1);
  await expect(control).toBeDisabled();
  await expect(status).toContainText("Loading host-wide task-worker extension discovery");

  releaseFirstGet?.();
  await expect(control).toBeEnabled();
  await expect(status).toContainText("new task workers only");
});

test("task worker extension discovery does not start a load while saving", async ({ page }) => {
  await openTaskWorkerSettings(page);
  const control = page.getByLabel("Task worker extension discovery");
  const status = page.locator("#task-worker-extension-policy-status");
  let releaseSave: (() => void) | undefined;
  let saveStarted: (() => void) | undefined;
  let getRequests = 0;
  const pendingSave = new Promise<void>((resolve) => { saveStarted = resolve; });
  await page.route("**/api/task-worker-settings", async (route) => {
    if (route.request().method() === "GET") {
      getRequests += 1;
      return route.continue();
    }
    saveStarted?.();
    await new Promise<void>((resolve) => { releaseSave = resolve; });
    await route.continue();
  });

  await control.selectOption("isolated");
  await pendingSave;
  await expect(control).toBeDisabled();
  await expect(status).toContainText("Saving host-wide task-worker extension discovery");

  await returnAndReopenTaskWorkerSettings(page);
  await expect.poll(() => getRequests).toBe(0);
  await expect(control).toBeDisabled();
  await expect(control).toHaveValue("isolated");
  await expect(status).toContainText("Saving host-wide task-worker extension discovery");

  releaseSave?.();
  await expect(control).toBeEnabled();
  await expect(control).toHaveValue("isolated");
  await expect(status).toContainText("saved");
});

test("task worker extension discovery retains an isolated value when a later real load fails", async ({ page }) => {
  await openTaskWorkerSettings(page);
  const control = page.getByLabel("Task worker extension discovery");
  const status = page.locator("#task-worker-extension-policy-status");
  await control.selectOption("isolated");
  await expect(status).toContainText("saved");
  await expect(control).toHaveValue("isolated");

  mkdirSync(join(server.home, ".wolfpack"), { recursive: true });
  writeFileSync(policyPath, '{"defaults":{"env":{"PRIVATE_CANARY":"later-load-secret"}}');
  await returnAndReopenTaskWorkerSettings(page);

  await expect(status).toContainText("Could not load host-wide task-worker extension discovery");
  await expect(control).toHaveValue("isolated");
  await expect(control).toBeDisabled();
  await expect(status).not.toContainText("later-load-secret");
});

test("task worker extension discovery reports real server failures and restores its confirmed value", async ({ page }) => {
  await openTaskWorkerSettings(page);
  const control = page.getByLabel("Task worker extension discovery");
  const status = page.locator("#task-worker-extension-policy-status");
  await expect(control).toHaveValue("inherit");

  mkdirSync(join(server.home, ".wolfpack"), { recursive: true });
  writeFileSync(policyPath, '{"defaults":{"env":{"PRIVATE_CANARY":"actual-browser-secret"}}');
  await control.focus();
  await expect(control).toBeFocused();
  await control.selectOption("isolated");

  await expect(status).toContainText("Could not save host-wide task-worker extension discovery");
  await expect(control).toHaveValue("inherit");
  await expect(status).not.toContainText("actual-browser-secret");
});
