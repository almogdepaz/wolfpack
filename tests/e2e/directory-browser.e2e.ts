import { expect, test, type Page } from "@playwright/test";

import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

interface TestWindow extends Window {
  showProjectPicker(machineUrl?: string): void;
}

const MACHINE_NAME = "studio-mac";
const BASE_DIRECTORY = "/server/projects";
const CHILD_DIRECTORY = "/server/projects/canonical-child";

const BASE_BREADCRUMBS = [
  { name: "/", path: "/" },
  { name: "server", path: "/server" },
  { name: "projects", path: BASE_DIRECTORY },
] as const;

async function openProjectPicker(page: Page): Promise<void> {
  await page.route("**/api/info", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: MACHINE_NAME, version: "1.6.18" }),
    });
  });
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: ["catalog-project"] }),
    });
  });
  await page.goto(server.baseUrl);
  await page.evaluate(() => (window as unknown as TestWindow).showProjectPicker());
  await expect(page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` })).toBeVisible();
}

async function routeAgentSelection(
  page: Page,
  createRequests: unknown[],
  nextNameRequests: URL[],
): Promise<void> {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }),
    });
  });
  await page.route("**/api/next-session-name**", async (route) => {
    nextNameRequests.push(new URL(route.request().url()));
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

async function routeDirectoryTree(page: Page, directoryRequests: Array<string | null>): Promise<void> {
  await page.route("**/api/directories**", async (route) => {
    const requestedPath = new URL(route.request().url()).searchParams.get("path");
    directoryRequests.push(requestedPath);
    const body = requestedPath === CHILD_DIRECTORY
      ? {
          current: CHILD_DIRECTORY,
          parent: BASE_DIRECTORY,
          breadcrumbs: [...BASE_BREADCRUMBS, { name: "canonical-child", path: CHILD_DIRECTORY }],
          directories: [],
        }
      : {
          current: BASE_DIRECTORY,
          parent: "/server",
          breadcrumbs: BASE_BREADCRUMBS,
          directories: [{ name: "canonical child", path: CHILD_DIRECTORY }],
        };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

function folderBrowser(page: Page): ReturnType<Page["getByRole"]> {
  return page.getByRole("region", { name: new RegExp(`folder on ${MACHINE_NAME}$`, "i") });
}

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("opens a canonical server folder from a dedicated host-labelled picker", async ({ page }) => {
  const directoryRequests: Array<string | null> = [];
  const createRequests: unknown[] = [];
  const nextNameRequests: URL[] = [];
  await routeDirectoryTree(page, directoryRequests);
  await routeAgentSelection(page, createRequests, nextNameRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` }).click();
  const browser = folderBrowser(page);
  await expect(browser).toBeVisible();
  await expect(page.locator("#directory-browser-dialog")).toHaveCount(0);
  await expect(browser.getByRole("navigation", { name: "Folder path" })).toContainText("projects");
  await browser.getByRole("button", { name: "Open canonical child" }).click();
  await expect(browser.locator("#directory-browser-current")).toHaveText(CHILD_DIRECTORY);
  await browser.getByRole("button", { name: "Open canonical-child folder" }).click();

  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
  await page.getByRole("button", { name: "Start shell" }).click();
  await expect.poll(() => createRequests).toEqual([{
    projectDir: CHILD_DIRECTORY,
    cmd: "shell",
    sessionName: "directory-session",
  }]);
  expect(directoryRequests).toEqual([null, CHILD_DIRECTORY]);
  expect(nextNameRequests).toHaveLength(1);
  expect(nextNameRequests[0].searchParams.get("projectDir")).toBe(CHILD_DIRECTORY);
  expect(nextNameRequests[0].searchParams.has("project")).toBe(false);
  expect(nextNameRequests[0].searchParams.has("newProject")).toBe(false);
});

test("jumps to an absolute server path without client-side path composition", async ({ page }) => {
  const directoryRequests: Array<string | null> = [];
  await routeDirectoryTree(page, directoryRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` }).click();
  const browser = folderBrowser(page);
  await browser.getByLabel(`Path on ${MACHINE_NAME}`).fill(CHILD_DIRECTORY);
  await browser.getByRole("button", { name: "Go to path" }).click();

  await expect(browser.locator("#directory-browser-current")).toHaveText(CHILD_DIRECTORY);
  expect(directoryRequests).toEqual([null, CHILD_DIRECTORY]);
});

test("restores project-picker focus after keyboard navigation and back", async ({ page }) => {
  const directoryRequests: Array<string | null> = [];
  await routeDirectoryTree(page, directoryRequests);
  await openProjectPicker(page);

  const openFolder = page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` });
  await openFolder.focus();
  await openFolder.press("Enter");
  const browser = folderBrowser(page);
  const current = browser.locator("#directory-browser-current");
  const child = browser.getByRole("button", { name: "Open canonical child" });
  await child.focus();
  await child.press("Enter");
  await expect(current).toHaveText(CHILD_DIRECTORY);
  await expect(current).toBeFocused();

  await browser.getByRole("button", { name: /^projects/ }).focus();
  await page.keyboard.press("Enter");
  await expect(current).toHaveText(BASE_DIRECTORY);
  await expect(current).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(browser).toBeHidden();
  await expect(openFolder).toBeFocused();
});

test("preserves keyboard focus and explains remote permission failures inline", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/directories**", async (route) => {
    requestCount++;
    if (requestCount === 1) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          current: BASE_DIRECTORY,
          parent: "/server",
          breadcrumbs: BASE_BREADCRUMBS,
          directories: [{ name: "protected", path: `${BASE_DIRECTORY}/protected` }],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "directory permission denied", code: "permission_denied" }),
    });
  });
  await openProjectPicker(page);

  await page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` }).click();
  const browser = folderBrowser(page);
  const protectedFolder = browser.getByRole("button", { name: "Open protected" });
  await protectedFolder.focus();
  await protectedFolder.press("Enter");

  const alert = browser.getByRole("alert");
  await expect(alert).toHaveText(
    `Wolfpack can't read this folder on ${MACHINE_NAME}. Grant the Wolfpack server access on that machine or choose another folder.`,
  );
  await expect(alert).toBeFocused();
  await expect(browser.getByRole("button", { name: "Open projects folder" })).toBeEnabled();
});

test("explains that a timed-out folder request may be waiting for macos authorization", async ({ page }) => {
  const stalledRequest = Promise.withResolvers<void>();
  await page.route("**/api/directories**", async (route) => {
    await stalledRequest.promise;
    await route.abort();
  });
  await openProjectPicker(page);
  await page.clock.install();

  try {
    await page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` }).click();
    await page.clock.fastForward(15_001);

    await expect(folderBrowser(page).getByRole("alert")).toHaveText(
      `The folder request timed out on ${MACHINE_NAME}. Wolfpack may be waiting for macOS folder authorization on that machine. Approve or deny the host prompt, or choose another folder.`,
    );
  } finally {
    stalledRequest.resolve();
  }
});

test("keeps project creation separate and returns only the selected parent", async ({ page }) => {
  const directoryRequests: Array<string | null> = [];
  const createRequests: unknown[] = [];
  const nextNameRequests: URL[] = [];
  await routeDirectoryTree(page, directoryRequests);
  await routeAgentSelection(page, createRequests, nextNameRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: `Create project on ${MACHINE_NAME}` }).click();
  const createProject = page.getByRole("region", { name: `Create project on ${MACHINE_NAME}` });
  const projectName = createProject.getByLabel("Project name");
  await projectName.fill("named-child");
  await createProject.getByRole("button", { name: "Change parent folder" }).click();

  const browser = folderBrowser(page);
  await expect(browser).toHaveAccessibleName(`Choose a parent folder on ${MACHINE_NAME}`);
  await browser.getByRole("button", { name: "Use projects as parent" }).click();
  await expect(createProject).toBeVisible();
  await expect(projectName).toHaveValue("named-child");
  await expect(createProject.getByText(BASE_DIRECTORY, { exact: true })).toBeVisible();
  await createProject.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Start shell" }).click();

  await expect.poll(() => createRequests).toEqual([{
    newProject: "named-child",
    newProjectParent: BASE_DIRECTORY,
    cmd: "shell",
    sessionName: "directory-session",
  }]);
  expect(nextNameRequests).toHaveLength(1);
  expect(nextNameRequests[0].searchParams.get("newProject")).toBe("named-child");
  expect(nextNameRequests[0].searchParams.has("project")).toBe(false);
  expect(nextNameRequests[0].searchParams.has("projectDir")).toBe(false);
});

test("uses configured-base creation without forcing directory browsing", async ({ page }) => {
  const createRequests: unknown[] = [];
  const nextNameRequests: URL[] = [];
  await routeAgentSelection(page, createRequests, nextNameRequests);
  await openProjectPicker(page);

  await page.getByRole("button", { name: `Create project on ${MACHINE_NAME}` }).click();
  const createProject = page.getByRole("region", { name: `Create project on ${MACHINE_NAME}` });
  await createProject.getByLabel("Project name").fill("default-child");
  await createProject.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Start shell" }).click();

  expect(nextNameRequests).toHaveLength(1);
  expect(nextNameRequests[0].searchParams.get("newProject")).toBe("default-child");
  await expect.poll(() => createRequests).toEqual([{
    newProject: "default-child",
    cmd: "shell",
    sessionName: "directory-session",
  }]);
});

test("keeps long remote paths and folder names inside the mobile viewport", async ({ page }) => {
  const longName = "directory-" + "x".repeat(140);
  const longPath = `${BASE_DIRECTORY}/${longName}`;
  await page.route("**/api/directories**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        current: longPath,
        parent: BASE_DIRECTORY,
        breadcrumbs: [...BASE_BREADCRUMBS, { name: longName, path: longPath }],
        directories: [{ name: longName, path: `${longPath}/${longName}` }],
      }),
    });
  });
  await openProjectPicker(page);
  await page.getByRole("button", { name: `Open folder on ${MACHINE_NAME}` }).click();

  const browser = folderBrowser(page);
  const layout = await browser.evaluate((element) => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelClientWidth: element.clientWidth,
    panelScrollWidth: element.scrollWidth,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelClientWidth);

  const folderRow = browser.getByRole("button", { name: `Open ${longName}`, exact: true });
  const rowBox = await folderRow.boundingBox();
  expect(rowBox?.height).toBeGreaterThanOrEqual(44);
});
