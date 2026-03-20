/**
 * Desktop grid navigation tests — covers the view-guard and suspend/resume paths
 * added in fix/grid-ralph-view-chaos.
 *
 * These tests use page.evaluate() to set up grid state directly, since the
 * WS/PTY layer is not fully exercisable in test mode (no real tmux). The goal
 * is to verify the view-transition and state-management logic that surrounds
 * the grid, not the terminal rendering itself.
 *
 * All tests require the desktop viewport (>768px) because addToGrid() and
 * suspendGridMode() are gated on isDesktop().
 */
import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

// These are desktop-only behaviours
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "grid is desktop-only (isDesktop() requires width > 768)");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Navigate to the page and wait for the session cards to load. */
async function loadApp(page: Page) {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
}

/**
 * Inject two fake grid sessions into page state without going through the PTY
 * layer. `controller: null` is intentional — dispose() is guarded.
 */
async function injectFakeGrid(page: Page) {
  await page.evaluate(() => {
    // @ts-ignore — page-global state
    state.gridSessions = [
      { session: "test-project", machine: "", controller: null, _cellElement: null },
      { session: "another-project", machine: "", controller: null, _cellElement: null },
    ];
    // @ts-ignore
    state.gridFocusIndex = 0;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("addToGrid from non-terminal view switches to terminal view first", async ({ page }) => {
  await loadApp(page);

  // Move to ralph-start view so currentView !== "terminal"
  await page.evaluate(() => {
    // @ts-ignore
    showView("ralph-start");
  });
  const viewBefore = await page.evaluate(() => {
    // @ts-ignore
    return state.currentView;
  });
  expect(viewBefore).toBe("ralph-start");

  // Calling addToGrid while NOT on the terminal view should auto-switch
  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    addToGrid("another-project", "");
  });

  const viewAfter = await page.evaluate(() => {
    // @ts-ignore
    return state.currentView;
  });
  expect(viewAfter).toBe("terminal");
});

test("navigating away from terminal with active grid suspends grid state", async ({ page }) => {
  await loadApp(page);

  // Go to terminal view and inject a fake two-session grid
  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal");
  });
  await injectFakeGrid(page);

  // Sanity: grid is active
  const active = await page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.length >= 2;
  });
  expect(active).toBe(true);

  // Navigate away → suspendGridMode() should fire
  await page.evaluate(() => {
    // @ts-ignore
    showView("ralph-start");
  });

  const preserved = await page.evaluate(() => {
    // @ts-ignore
    return state.preservedGridSessions.map((s: { session: string }) => s.session);
  });
  expect(preserved).toContain("test-project");
  expect(preserved).toContain("another-project");

  // Live grid sessions should be cleared after suspension
  const liveSessions = await page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.length;
  });
  expect(liveSessions).toBe(0);
});

test("backFromRalph restores a suspended grid", async ({ page }) => {
  await loadApp(page);

  // Pre-seed the preserved grid state (simulates having navigated away earlier)
  await page.evaluate(() => {
    // @ts-ignore
    state.preservedGridSessions = [
      { session: "test-project", machine: "" },
      { session: "another-project", machine: "" },
    ];
    // @ts-ignore
    state.preservedGridFocusIndex = 1;
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // Navigate to ralph-detail without going through terminal (avoid triggering suspend)
    // @ts-ignore
    setState({ currentView: "ralph-detail" });
    const el = document.getElementById("ralph-detail-view");
    if (el) el.classList.add("visible");
    const termEl = document.getElementById("terminal-view");
    if (termEl) termEl.classList.remove("visible");
  });

  // Click the ← Back button in the ralph-detail view
  const backBtn = page.locator("#ralph-detail-view button.picker-cancel-btn");
  await expect(backBtn).toBeVisible();
  await backBtn.click();

  // Should have restored the grid
  const viewAfter = await page.evaluate(() => {
    // @ts-ignore
    return state.currentView;
  });
  expect(viewAfter).toBe("terminal");

  const restoredSessions = await page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.map((s: { session: string }) => s.session);
  });
  expect(restoredSessions).toContain("test-project");
  expect(restoredSessions).toContain("another-project");

  // Preserved state should be cleared after restore
  const preservedAfter = await page.evaluate(() => {
    // @ts-ignore
    return state.preservedGridSessions.length;
  });
  expect(preservedAfter).toBe(0);
});

test("re-adding the remaining preserved session from Ralph reinitializes terminal view", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // Start on Ralph with a suspended 2-session grid focused on another-project.
    // @ts-ignore
    state.preservedGridSessions = [
      { session: "test-project", machine: "" },
      { session: "another-project", machine: "" },
    ];
    // @ts-ignore
    state.preservedGridFocusIndex = 1;
    // @ts-ignore
    state.currentSession = "another-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    state.useDesktopTerminal = true;
    // @ts-ignore
    showView("ralph-detail");
  });

  await page.evaluate(() => {
    // First click removes test-project from the preserved grid, leaving
    // another-project as the current single session.
    // @ts-ignore
    toggleGrid("test-project", "", null);
  });

  await page.evaluate(() => {
    // Second click re-adds the remaining current session from Ralph.
    // This used to route through switchSession()'s same-session fast path
    // and return without initializing the desktop terminal, leaving a blank view.
    // @ts-ignore
    toggleGrid("another-project", "", null);
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.currentView;
  })).toBe("terminal");

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return !!state.terminalController;
  })).toBe(true);

  await expect.poll(async () => page.evaluate(() => {
    const el = document.getElementById("desktop-terminal-container");
    return el ? getComputedStyle(el).display : "none";
  })).toBe("block");
});
