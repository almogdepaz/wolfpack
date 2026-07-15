import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

type WolfpackTestWindow = Window & {
  openSession(name: string, machineUrl?: string): void;
  showProjectPicker(machineUrl?: string): void;
  showRalphStart(machineUrl?: string): void;
};

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("desktop escape from new-session picker returns to expanded sessions, not an empty terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop expanded-session regression");

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("test-project"));
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);

  await page.locator("#sidebar-expand-btn").click();
  await expect(page.locator("body")).toHaveClass(/sessions-expanded/);
  await expect(page.locator("#sessions-view")).toHaveClass(/visible/);

  await page.locator(".machine-add-btn").first().click();
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);

  await page.keyboard.press("Escape");

  await expect(page.locator("body")).toHaveClass(/sessions-expanded/);
  await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
});

test("desktop escape from new-session picker reopens the previous terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal-origin regression");

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("test-project"));
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);

  await page.keyboard.press("Escape");

  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });
});

test("desktop settings back from a terminal reopens that terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal-origin regression");

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("test-project"));
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });

  await page.locator("#sidebar-settings-btn").click();
  await expect(page.locator("#settings-view")).toHaveClass(/visible/);

  await page.locator("#settings-back-btn").click();

  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });
});

test("ralph picker lists only enabled configured ralph agents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop ralph picker regression");

  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ ralphEnabled: true }));
  });
  const hostileProject = 'quote" data-injected="yes';
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        settings: { agentCmd: "codex", cmds: [] },
        effective: {
          agentCmd: "codex",
          cmds: ["shell", "codex", "gemini", "claude --model opus", "pi"],
          ralphAgents: ["codex", "gemini"],
        },
      }),
    });
  });
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: ["safe-project", hostileProject] }),
    });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showRalphStart());

  await expect(page.locator("#ralph-agent-select option")).toHaveText(["codex", "gemini"]);
  await expect(page.locator("#ralph-agent-select")).toBeEnabled();
  const hostileOption = page.locator("#ralph-project-select option").filter({ hasText: hostileProject });
  expect(await hostileOption.getAttribute("value")).toBe(hostileProject);
  await expect(hostileOption).not.toHaveAttribute("data-injected", "yes");
});

test("ralph picker does not treat synthesized defaults as configured agents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop ralph picker regression");

  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ ralphEnabled: true }));
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        settings: { agentCmd: "shell", cmds: [
          { cmd: "shell", enabled: true },
          { cmd: "claude", enabled: true },
          { cmd: "codex", enabled: true },
        ] },
        effective: {
          agentCmd: "shell",
          cmds: ["shell", "claude", "codex"],
          ralphAgents: [],
        },
      }),
    });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showRalphStart());

  await expect(page.locator("#ralph-agent-select option")).toHaveText(["no enabled Ralph agents"]);
  await expect(page.locator("#ralph-agent-select")).toBeDisabled();
});

test("desktop escape from ralph launched from a terminal reopens that terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal-origin regression");

  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ ralphEnabled: true }));
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("test-project"));
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showRalphStart());
  await expect(page.locator("#ralph-start-view")).toHaveClass(/visible/);

  await page.keyboard.press("Escape");

  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible({ timeout: 10_000 });
});
