/**
 * Kobra Kai e2e tests — navigation, form, validation, DAG rendering, cancel.
 *
 * Uses Playwright route mocking for kobra-kai API endpoints so we don't
 * need real LLM/worktree infrastructure.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_PROJECTS = ["test-project", "another-project"];

const MOCK_DAG = {
  tasks: [
    {
      id: "1",
      title: "setup auth module",
      description: "create authentication middleware",
      depends_on: [],
      estimated_files: ["src/auth.ts", "src/middleware.ts"],
      wave: 0,
      status: "completed",
    },
    {
      id: "2",
      title: "build user model",
      description: "database schema for users",
      depends_on: [],
      estimated_files: ["src/models/user.ts"],
      wave: 0,
      status: "in_progress",
    },
    {
      id: "3",
      title: "wire up login endpoint",
      description: "POST /api/login with JWT",
      depends_on: ["1", "2"],
      estimated_files: ["src/routes/login.ts"],
      wave: 1,
      status: "pending",
    },
  ],
  waves: [
    { wave: 0, task_ids: ["1", "2"], status: "in_progress" },
    { wave: 1, task_ids: ["3"], status: "pending" },
  ],
  metadata: { project: "test-project", created_at: "2026-01-01", source: "decomposed" },
};

const MOCK_ACTIVE_STATUS = {
  project: "test-project",
  status: "active",
  currentWave: 0,
  totalWaves: 2,
  tasks: MOCK_DAG.tasks,
  waves: MOCK_DAG.waves,
  activeAgents: 1,
  queuedTasks: 1,
  maxConcurrent: 3,
  startedAt: "2026-01-01T00:00:00Z",
};

const MOCK_IDLE_STATUS = {
  project: "test-project",
  status: "idle",
  currentWave: 0,
  totalWaves: 0,
  tasks: [],
  waves: [],
  activeAgents: 0,
  queuedTasks: 0,
  maxConcurrent: 3,
  startedAt: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Set up route mocks for kobra-kai endpoints. Accepts overrides per endpoint. */
async function mockKobraKaiAPIs(
  page: Page,
  opts: {
    status?: object;
    planResponse?: object | { error: string; statusCode: number };
    launchResponse?: object | { error: string; statusCode: number };
    cancelResponse?: object;
  } = {},
) {
  const statusResponse = opts.status ?? MOCK_IDLE_STATUS;

  // Mock /api/projects to return consistent test projects
  await page.route("**/api/projects", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: MOCK_PROJECTS }),
    });
  });

  // Mock kobra-kai status — returns idle or active based on config
  await page.route("**/api/kobra-kai/status*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statusResponse),
    });
  });

  // Mock plan endpoint
  if (opts.planResponse) {
    const pr = opts.planResponse as any;
    await page.route("**/api/kobra-kai/plan", async (route: Route) => {
      const sc = pr.statusCode || 200;
      const body = pr.statusCode ? { error: pr.error } : pr;
      await route.fulfill({
        status: sc,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }

  // Mock launch endpoint
  if (opts.launchResponse) {
    const lr = opts.launchResponse as any;
    await page.route("**/api/kobra-kai/launch", async (route: Route) => {
      const sc = lr.statusCode || 200;
      const body = lr.statusCode ? { error: lr.error } : lr;
      await route.fulfill({
        status: sc,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }

  // Mock cancel endpoint
  await page.route("**/api/kobra-kai/cancel*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.cancelResponse ?? { ok: true }),
    });
  });

  // Mock ralph plans (used by schedule mode dropdown)
  await page.route("**/api/ralph/plans*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plans: ["PLAN.md", "roadmap.md"] }),
    });
  });
}

/** Navigate to kobra kai view by clicking the 🥋 button (mobile) */
async function openKobraKaiView(page: Page) {
  const kobraBtn = page.locator("#kobra-btn");
  await kobraBtn.click();
  await expect(page.locator("#kobra-kai-view")).toHaveClass(/visible/);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("kobra kai — navigation", () => {
  test("toggle kobra kai view via header button (mobile)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile header navigation");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    // Open kobra kai
    await openKobraKaiView(page);
    const kkView = page.locator("#kobra-kai-view");
    await expect(kkView).toBeVisible();

    // Should show "no active orchestrations" (idle status)
    await expect(kkView.locator("text=no active orchestrations")).toBeVisible({ timeout: 3000 });

    // Toggle back to sessions
    const kobraBtn = page.locator("#kobra-btn");
    await kobraBtn.click();
    await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  });

  test("back button returns to sessions from kobra kai (mobile)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile back button");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    await openKobraKaiView(page);
    await expect(page.locator("#kobra-kai-view")).toBeVisible();

    // Click back button
    const backBtn = page.locator("#back-btn");
    await backBtn.click();
    await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  });
});

test.describe("kobra kai — form", () => {
  test("open and close new orchestration form", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile form interaction");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    // Click "+ New" button
    const newBtn = page.locator(".kk-new-btn");
    await newBtn.click();

    // Form should be visible
    const form = page.locator("#kk-form");
    await expect(form).toBeVisible();

    // Project dropdown should have options
    const projectSelect = page.locator("#kk-project");
    await expect(projectSelect).toBeVisible();
    const options = projectSelect.locator("option");
    await expect(options).toHaveCount(2);

    // Cancel form
    const cancelBtn = page.locator(".kk-cancel-btn");
    await cancelBtn.click();
    await expect(form).not.toBeVisible();
  });

  test("mode tabs switch between decompose and schedule", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile form interaction");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    const newBtn = page.locator(".kk-new-btn");
    await newBtn.click();

    // Default: decompose mode — goal textarea visible
    const goalField = page.locator("#kk-decompose-fields");
    const scheduleField = page.locator("#kk-schedule-fields");
    await expect(goalField).toBeVisible();
    await expect(scheduleField).not.toBeVisible();

    // Switch to schedule mode
    const scheduleTab = page.locator(".kk-mode-tab", { hasText: "schedule plan" });
    await scheduleTab.click();
    await expect(goalField).not.toBeVisible();
    await expect(scheduleField).toBeVisible();

    // Plan file dropdown should have options
    const planSelect = page.locator("#kk-plan-file");
    await expect(planSelect).toBeVisible();
    const options = planSelect.locator("option");
    await expect(options).toHaveCount(2);

    // Switch back to decompose
    const decomposeTab = page.locator(".kk-mode-tab", { hasText: "decompose goal" });
    await decomposeTab.click();
    await expect(goalField).toBeVisible();
    await expect(scheduleField).not.toBeVisible();
  });
});

test.describe("kobra kai — validation", () => {
  test("empty goal shows inline error", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile form interaction");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    // Open form
    await page.locator(".kk-new-btn").click();

    // Don't type any goal — just click launch
    await page.locator(".kk-launch-btn").click();

    // Should show inline error (the error is thrown as "enter a goal" in the catch block)
    const errorDiv = page.locator("#kk-form-error");
    await expect(errorDiv).toBeVisible({ timeout: 2000 });
    await expect(errorDiv).toHaveText("enter a goal");
  });
});

test.describe("kobra kai — DAG rendering", () => {
  test("active orchestration renders wave groups and tasks", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile DAG rendering");
    await mockKobraKaiAPIs(page, { status: MOCK_ACTIVE_STATUS });
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    // Wait for DAG to render
    const dagContainer = page.locator("#kk-active-orchestration");
    await expect(dagContainer).toBeVisible({ timeout: 5000 });

    // Should show project name
    await expect(dagContainer.locator("text=test-project")).toBeVisible();

    // Should show wave groups
    const waveLabels = dagContainer.locator(".kk-wave-label");
    await expect(waveLabels).toHaveCount(2);

    // Should show task rows
    const taskRows = dagContainer.locator(".kk-task-row");
    await expect(taskRows).toHaveCount(3);

    // Check task titles are rendered
    await expect(dagContainer.locator("text=setup auth module")).toBeVisible();
    await expect(dagContainer.locator("text=build user model")).toBeVisible();
    await expect(dagContainer.locator("text=wire up login endpoint")).toBeVisible();

    // Progress bar container should exist (fill may be 0-width when no waves completed)
    const progressBar = dagContainer.locator(".kk-progress");
    await expect(progressBar).toBeVisible();

    // Cancel button should be present
    const cancelBtn = dagContainer.locator(".kk-cancel-action");
    await expect(cancelBtn).toBeVisible();
    await expect(cancelBtn).toHaveText("cancel orchestration");
  });

  test("task row expands to show detail panel", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile task expand");
    await mockKobraKaiAPIs(page, { status: MOCK_ACTIVE_STATUS });
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    const dagContainer = page.locator("#kk-active-orchestration");
    await expect(dagContainer).toBeVisible({ timeout: 5000 });

    // Click first task row to expand
    const firstTask = dagContainer.locator(".kk-task-row").first();
    await firstTask.click();
    await expect(firstTask).toHaveClass(/expanded/);

    // Detail panel should now have max-height > 0 (expanded via CSS)
    const detail = dagContainer.locator(".kk-task-detail").first();
    // Check that the description is rendered in the detail
    await expect(detail.locator("text=create authentication middleware")).toBeVisible({ timeout: 2000 });
    // Files should show
    await expect(detail.locator("text=src/auth.ts")).toBeVisible();

    // Click again to collapse
    await firstTask.click();
    await expect(firstTask).not.toHaveClass(/expanded/);
  });

  test("cancel orchestration button works", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile cancel button");
    let cancelCalled = false;
    await mockKobraKaiAPIs(page, { status: MOCK_ACTIVE_STATUS });

    // Intercept cancel to verify it's called, then switch to idle
    await page.route("**/api/kobra-kai/cancel*", async (route: Route) => {
      cancelCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    const dagContainer = page.locator("#kk-active-orchestration");
    await expect(dagContainer).toBeVisible({ timeout: 5000 });

    // Now mock status to return idle after cancel
    await page.route("**/api/kobra-kai/status*", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_IDLE_STATUS),
      });
    });

    // Click cancel
    const cancelBtn = dagContainer.locator(".kk-cancel-action");
    await cancelBtn.click();

    // Should reload and show idle state
    await expect(page.locator("text=no active orchestrations")).toBeVisible({ timeout: 5000 });
    expect(cancelCalled).toBe(true);
  });
});

test.describe("kobra kai — full flow", () => {
  test("form → plan → launch → DAG displays", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile full flow");

    // Start with idle status, switch to active after launch
    let launched = false;
    await mockKobraKaiAPIs(page, {
      planResponse: MOCK_DAG,
      launchResponse: { ok: true, waves: 2, tasks: 3 },
    });

    // Status switches from idle to active after launch
    await page.route("**/api/kobra-kai/status*", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(launched ? MOCK_ACTIVE_STATUS : MOCK_IDLE_STATUS),
      });
    });

    // Track launch call to flip status
    await page.route("**/api/kobra-kai/launch", async (route: Route) => {
      launched = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, waves: 2, tasks: 3 }),
      });
    });

    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    // Idle state
    await expect(page.locator("text=no active orchestrations")).toBeVisible({ timeout: 3000 });

    // Open form
    await page.locator(".kk-new-btn").click();
    const form = page.locator("#kk-form");
    await expect(form).toBeVisible();

    // Select project (already selected — first option)
    const projectSelect = page.locator("#kk-project");
    await expect(projectSelect).toHaveValue("test-project");

    // Enter goal
    await page.locator("#kk-goal").fill("implement user authentication with JWT");

    // Launch
    await page.locator(".kk-launch-btn").click();

    // Should transition to DAG view
    const dagContainer = page.locator("#kk-active-orchestration");
    await expect(dagContainer).toBeVisible({ timeout: 5000 });
    // Use scoped locator to avoid matching session cards
    await expect(dagContainer.locator("text=test-project")).toBeVisible();
    await expect(dagContainer.locator(".kk-wave-group")).toHaveCount(2, { timeout: 5000 });
  });
});

test.describe("kobra kai — existing views unaffected", () => {
  test("sessions view still works after visiting kobra kai", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile session flow");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    // Verify sessions render
    const cards = page.locator(".card");
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);

    // Visit kobra kai and come back
    await openKobraKaiView(page);
    await expect(page.locator("#kobra-kai-view")).toBeVisible();
    await page.locator("#kobra-btn").click();
    await expect(page.locator("#sessions-view")).toHaveClass(/visible/);

    // Sessions should still be there, same count
    await expect(cards).toHaveCount(initialCount);

    // Click into a session — terminal should still work
    const card = page.locator(".card", { hasText: "test-project" }).first();
    await card.click();
    await expect(page.locator("#terminal-view")).toBeVisible({ timeout: 5000 });
  });

  test("settings view still works after visiting kobra kai", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile settings flow");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    // Visit kobra kai
    await openKobraKaiView(page);
    await expect(page.locator("#kobra-kai-view")).toBeVisible();

    // Go back to sessions
    await page.locator("#kobra-btn").click();
    await expect(page.locator("#sessions-view")).toHaveClass(/visible/);

    // Open settings
    await page.locator("#gear-btn").click();
    await expect(page.locator("#settings-view")).toHaveClass(/visible/);
  });
});

test.describe("kobra kai — desktop layout", () => {
  test("kobra kai view renders in desktop sidebar context", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop-only test");
    await mockKobraKaiAPIs(page, { status: MOCK_ACTIVE_STATUS });
    await page.goto(srv.baseUrl);

    // Wait for DOM ready (not networkidle — KK polling prevents idle state)
    await page.waitForLoadState("domcontentloaded");

    // Desktop sidebar should be present
    const sidebar = page.locator("#desktop-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Look for kobra kai nav item in sidebar
    const kkNavItem = sidebar.locator("[data-view='kobra-kai']");
    const kkExists = await kkNavItem.count();

    if (kkExists > 0) {
      // Sidebar has KK nav — click it
      await kkNavItem.click();
    } else {
      // Fallback: trigger via JS if no sidebar nav item
      await page.evaluate(() => {
        (window as any).toggleKobraKaiView?.();
      });
    }

    // Verify view is visible
    const kkView = page.locator("#kobra-kai-view");
    await expect(kkView).toBeVisible({ timeout: 5000 });

    // DAG should render
    await expect(kkView.locator(".kk-wave-group")).toHaveCount(2, { timeout: 5000 });
    await expect(kkView.locator(".kk-task-row")).toHaveCount(3);
  });
});

test.describe("kobra kai — CSS isolation", () => {
  test("kk styles don't bleed into session cards", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile CSS check");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    // Check session card border-color is NOT the KK orange
    const card = page.locator(".card").first();
    const borderColor = await card.evaluate((el) => getComputedStyle(el).borderLeftColor);
    // Session cards use #333 (rgb(51,51,51)) or triage colors, never kk orange (#f39c12 = rgb(243,156,18))
    expect(borderColor).not.toBe("rgb(243, 156, 18)");

    // Verify session card font color isn't KK orange either
    const cardName = page.locator(".card-name").first();
    const nameColor = await cardName.evaluate((el) => getComputedStyle(el).color);
    expect(nameColor).not.toBe("rgb(243, 156, 18)");
  });

  test("kobra kai view has correct accent color", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile CSS check");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });
    await openKobraKaiView(page);

    // Open form to check KK button accent
    await page.locator(".kk-new-btn").click();
    const launchBtn = page.locator(".kk-launch-btn");
    const btnColor = await launchBtn.evaluate((el) => getComputedStyle(el).color);
    // Should be KK orange #f39c12 = rgb(243, 156, 18)
    expect(btnColor).toBe("rgb(243, 156, 18)");
  });

  test("no layout shift when toggling kobra kai", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "mobile layout check");
    await mockKobraKaiAPIs(page);
    await page.goto(srv.baseUrl);
    await page.waitForSelector(".card", { timeout: 5000 });

    // Measure sessions view dimensions
    const sessionsView = page.locator("#sessions-view");
    const beforeBox = await sessionsView.boundingBox();
    expect(beforeBox).toBeTruthy();

    // Toggle to KK and back
    await openKobraKaiView(page);
    await page.locator("#kobra-btn").click();
    await expect(sessionsView).toHaveClass(/visible/);

    // Measure again
    const afterBox = await sessionsView.boundingBox();
    expect(afterBox).toBeTruthy();
    expect(afterBox!.width).toBe(beforeBox!.width);
    expect(afterBox!.height).toBe(beforeBox!.height);
  });
});
