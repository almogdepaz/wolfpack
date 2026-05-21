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

test("addToGrid from terminal view shows grid loading immediately", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // Hold async terminal mount open so this checks the pre-mount gap that
    // used to expose stale/full-width terminal content before hydration began.
    // @ts-ignore
    window.ghosttyReady = new Promise(() => {});
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  const cellStates = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.map((cell) => ({
      loading: cell.classList.contains("grid-loading"),
      hydrating: cell.classList.contains("hydrating"),
    })),
  );

  expect(cellStates).toHaveLength(2);
  for (const cell of cellStates) {
    expect(cell.loading || cell.hydrating).toBe(true);
  }
});

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
    // Navigate to ralph-detail via showView so the back button display is set
    // (it's display:none by default; showView toggles inline-block based on
    // effectiveName). From "sessions" this won't suspend a grid — suspend
    // only fires when leaving "terminal" with an active grid.
    // @ts-ignore
    showView("ralph-detail");
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

// ── Black-canvas regression: forceRepaint must fire after pty_ready ──────────
//
// Bug: grid cells render black until window resize/devtools-open. Single-terminal
// path was fixed in 75d6ff3 by calling forceRepaint() in onPtyReady. Grid path
// does not pass onPtyReady to createPtyTerminalController, so the manual
// #0a0a0a fillRect (app.ts:1006-1011) sticks until something forces a render.

test("addToGrid triggers forceRepaint per cell after pty_ready", async ({ page }) => {
  await loadApp(page);

  // Open a single terminal first so addToGrid promotes single→grid (2 cells).
  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    initTerminal();
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return !!state.terminalController?.term;
  }), { timeout: 5000 }).toBe(true);

  // addToGrid synchronously creates both controllers (mountGridController
  // assigns gs.controller before its first await — see app-grid.ts:135 + 196).
  // Wrapping forceRepaint immediately after the call wins the race vs the
  // WS pty_ready round-trip.
  await page.evaluate(() => {
    // @ts-ignore
    addToGrid("another-project", "");
    // @ts-ignore
    state.gridSessions.forEach((gs) => {
      gs._forceRepaintCount = 0;
      const orig = gs.controller.forceRepaint.bind(gs.controller);
      gs.controller.forceRepaint = () => { gs._forceRepaintCount++; orig(); };
    });
  });

  // Wait for WS handshake + pty_ready on every cell.
  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => !!gs.controller?.isConnected);
  }), { timeout: 5000 }).toBe(true);

  // After pty_ready settles, every cell should have had ≥1 forced repaint.
  // Without the fix this stays at 0 and the cell shows the manual blackfill.
  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => gs._forceRepaintCount >= 1);
  }), { timeout: 3000 }).toBe(true);
});

test("long-background visibilitychange reconnects each grid cell and repaints", async ({ page }) => {
  await loadApp(page);

  // Build a 2-cell grid first.
  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    initTerminal();
  });
  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return !!state.terminalController?.term;
  }), { timeout: 5000 }).toBe(true);

  await page.evaluate(() => {
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => !!gs.controller?.isConnected);
  }), { timeout: 5000 }).toBe(true);

  // Reset spy counters AFTER initial connect so we measure only post-reconnect repaints.
  await page.evaluate(() => {
    // @ts-ignore
    state.gridSessions.forEach((gs) => {
      gs._forceRepaintCount = 0;
      gs._reconnectCount = 0;
      const origRepaint = gs.controller.forceRepaint.bind(gs.controller);
      gs.controller.forceRepaint = () => { gs._forceRepaintCount++; origRepaint(); };
      const origReconnect = gs.controller.reconnect.bind(gs.controller);
      gs.controller.reconnect = (...args: unknown[]) => { gs._reconnectCount++; return origReconnect(...args); };
    });
  });

  // Simulate >60s background: monkey-patch Date.now so the visibility handler
  // sees `hiddenDuration > 60_000` between the hidden/visible flip.
  await page.evaluate(() => {
    const origNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => origNow() + offset;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    // Now jump 70s forward so the visible-event sees a long gap.
    offset = 70_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // Each cell should have been told to reconnect.
  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.map((gs) => gs._reconnectCount);
  }), { timeout: 3000 }).toEqual([
    expect.any(Number),
    expect.any(Number),
  ]);

  const reconnectCounts = await page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.map((gs) => gs._reconnectCount);
  });
  for (const r of reconnectCounts) expect(r).toBeGreaterThanOrEqual(1);

  // After reconnect → new pty_ready arrives → forceRepaint should fire (with fix).
  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => gs._forceRepaintCount >= 1);
  }), { timeout: 5000 }).toBe(true);
});
