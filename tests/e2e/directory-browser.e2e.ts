import { expect, test, type Page } from "@playwright/test";

import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

interface TestWindow extends Window {
  showProjectPicker(machineUrl?: string): void;
}

const BASE_DIRECTORY = "/server/projects";
const CHILD_DIRECTORY = "/server/projects/canonical-child";

async function openProjectPicker(page: Page): Promise<void> {
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: ["catalog-project"] }),
    });
  });
  await page.goto(server.baseUrl);
  await page.evaluate(() => (window as unknown as TestWindow).showProjectPicker());
}

async function routeAgentSelection(page: Page, createRequests: unknown[]): Promise<void> {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }),
    });
  });
  await page.route(/\/api\/next-session-name\?/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "directory-session" }),
    });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, session: "directory-session" }),
    });
  });
}

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("opens a canonical browsed directory through the existing projectDir launch path", async ({ page }) => {
  const directoryRequests: Array<string | null> = [];
  const createRequests: unknown[] = [];
  await page.route("**/api/directories**", async (route) => {
    const requestedPath = new URL(route.request().url()).searchParams.get("path");
    directoryRequests.push(requestedPath);
    const body = requestedPath === CHILD_DIRECTORY
      ? { current: CHILD_DIRECTORY, parent: BASE_DIRECTORY, directories: [] }
      : {
          current: BASE_DIRECTORY,
          parent: "/server",
          directories: [{ name: "canonical child", path: CHILD_DIRECTORY }],
        };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await routeAgentSelection(page, createRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: "Browse server directories" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse server directories" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(BASE_DIRECTORY, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Browse canonical child" }).click();
  await expect(dialog.getByText(CHILD_DIRECTORY, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Open folder" }).click();

  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
  await page.getByRole("button", { name: "Start shell" }).click();
  await expect.poll(() => createRequests).toEqual([{
    projectDir: CHILD_DIRECTORY,
    cmd: "shell",
    sessionName: "directory-session",
  }]);
  expect(directoryRequests).toEqual([null, CHILD_DIRECTORY]);
});

test("records Create here as the parent for the existing project-name flow", async ({ page }) => {
  const createRequests: unknown[] = [];
  await page.route("**/api/directories**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ current: BASE_DIRECTORY, parent: "/server", directories: [] }),
    });
  });
  await routeAgentSelection(page, createRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: "Browse server directories" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse server directories" });
  await dialog.getByRole("button", { name: "Create here" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#new-project-create-name")).toBeFocused();
  await page.locator("#new-project-create-name").fill("named-child");
  await page.getByRole("button", { name: "Create new project" }).click();
  await page.getByRole("button", { name: "Start shell" }).click();

  await expect.poll(() => createRequests).toEqual([{
    newProject: "named-child",
    newProjectParent: BASE_DIRECTORY,
    cmd: "shell",
    sessionName: "directory-session",
  }]);
});

test("exposes bounded errors and restores Browse focus after keyboard dismissal", async ({ page }) => {
  await page.route("**/api/directories**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "directory unavailable", code: "unavailable" }),
    });
  });
  await openProjectPicker(page);

  const browse = page.getByRole("button", { name: "Browse server directories" });
  await browse.focus();
  await browse.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Browse server directories" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText("directory unavailable");
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(browse).toBeFocused();
});
