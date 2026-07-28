/**
 * Desktop grid navigation tests — covers the view-guard and suspend/resume paths
 * added for grid/navigation regressions.
 *
 * These tests use page.evaluate() to set up grid state directly, since the
 * WS/PTY layer is not fully exercisable in test mode (no real tmux). The goal
 * is to verify the view-transition and state-management logic that surrounds
 * the grid, not the terminal rendering itself.
 *
 * All tests require the desktop viewport (>768px) because addToGrid() and
 * suspendGridMode() are gated on isDesktop().
 */
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";
import { CLOSE_CODE_PREFILL_TIMEOUT, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";

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
async function routeHydratedPty(page: Page): Promise<Map<string, WebSocketRoute>> {
  const sockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    sockets.set(session, ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") {
        ws.send(JSON.stringify({ type: "prefill_viewport" }));
      }
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  return sockets;
}

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

test("sub-session notification adds a child beside the active single parent", async ({ page }) => {
  const sockets = await routeHydratedPty(page);
  await loadApp(page);
  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect.poll(() => sockets.has("test-project")).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.currentSession === "test-project" && state.terminalController?.isConnected;
  })).toBe(true);

  sockets.get("test-project")!.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));

  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.map((entry) => entry.session);
  })).toEqual(["test-project", "another-project"]);
});

test("sub-session notification ignores other parents, views, and existing grids", async ({ page }) => {
  const sockets = await routeHydratedPty(page);
  await loadApp(page);
  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect.poll(() => sockets.has("test-project")).toBe(true);
  const parentSocket = sockets.get("test-project")!;

  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "another-project",
    session: "third-project",
  }));
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.length;
  })).toBe(0);

  await page.evaluate(() => {
    // @ts-ignore exercise the message guard without changing socket ownership
    state.currentView = "settings";
  });
  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.length;
  })).toBe(0);

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    state.currentView = "terminal";
  });
  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.map((entry) => entry.session);
  })).toEqual(["test-project", "another-project"]);

  await expect.poll(() => sockets.get("test-project")).not.toBeUndefined();
  sockets.get("test-project")!.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "third-project",
  }));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.map((entry) => entry.session);
  })).toEqual(["test-project", "another-project"]);
});

test("grid requests viewport prefill", async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; prefillMode?: string }> }>;
    };
    const traces = Object.values(debugWindow.__wfTrace || {});
    return ["test-project", "another-project"].every((session) =>
      traces.some((trace) =>
        trace._meta.session === session &&
        trace.events.some((event) => event.kind === "attach.send" && event.prefillMode === "viewport"),
      ),
    );
  }), { timeout: 5000 }).toBe(true);
});

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

test("grid topology add hides existing canvases until relayout repaint completes", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.length === 2 && state.gridSessions.every((gs) =>
      gs.controller?.isConnected &&
      !gs.controller?.hydration?.pending &&
      gs._cellElement?.classList.contains("hydrated")
    );
  }), { timeout: 5000 }).toBe(true);

  const immediate = await page.evaluate(() => {
    // @ts-ignore
    const existing = state.gridSessions.map((gs) => gs._cellElement);
    // @ts-ignore
    addToGrid("third-project", "");
    return existing.map((cell: HTMLElement) => {
      const canvas = cell.querySelector("canvas");
      return {
        transitioning: cell.classList.contains("transitioning"),
        visibility: canvas ? getComputedStyle(canvas).visibility : "missing",
      };
    });
  });

  expect(immediate).toEqual([
    { transitioning: true, visibility: "hidden" },
    { transitioning: true, visibility: "hidden" },
  ]);

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.slice(0, 2).every((gs) => {
      const cell = gs._cellElement;
      const canvas = cell?.querySelector("canvas");
      return cell && canvas &&
        !cell.classList.contains("transitioning") &&
        getComputedStyle(canvas).visibility === "visible";
    });
  }), { timeout: 5000 }).toBe(true);
});

test("grid topology add waits one frame after relayout repaint before revealing existing cells", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.length === 2 && state.gridSessions.every((gs) =>
      gs.controller?.isConnected &&
      !gs.controller?.hydration?.pending &&
      gs._cellElement?.classList.contains("hydrated")
    );
  }), { timeout: 5000 }).toBe(true);

  const states = await page.evaluate(async () => {
    // @ts-ignore
    const existing = state.gridSessions.map((gs) => gs._cellElement as HTMLElement);
    // @ts-ignore
    addToGrid("third-project", "");
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextFrame();
    await nextFrame();
    const afterRepaintRequestFrame = existing.map((cell: HTMLElement) => cell.classList.contains("transitioning"));
    await nextFrame();
    const afterRevealFrame = existing.map((cell: HTMLElement) => cell.classList.contains("transitioning"));
    return { afterRepaintRequestFrame, afterRevealFrame };
  });

  expect(states.afterRepaintRequestFrame).toEqual([true, true]);
  expect(states.afterRevealFrame).toEqual([false, false]);
});

test("addToGrid hides single terminal container before grid cells mount", async ({ page }) => {
  await loadApp(page);

  const immediateState = await page.evaluate(() => {
    // Hold async grid terminal mount open so this inspects the synchronous
    // single-terminal → grid transition gap.
    // @ts-ignore
    window.ghosttyReady = new Promise(() => {});
    const terminal = document.getElementById("desktop-terminal-container")!;
    terminal.style.display = "block";
    terminal.classList.add("hydrated");
    const canvas = document.createElement("canvas");
    terminal.appendChild(canvas);
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
    return {
      terminalDisplay: getComputedStyle(terminal).display,
      gridActive: document.getElementById("desktop-grid-container")?.classList.contains("active") ?? false,
      gridCells: document.querySelectorAll("#desktop-grid-container .grid-cell").length,
    };
  });

  expect(immediateState).toEqual({
    terminalDisplay: "none",
    gridActive: true,
    gridCells: 2,
  });
});

test("grid cached snapshots stay behind loading screen until hydration", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    localStorage.setItem(
      "wp-snap||test-project",
      JSON.stringify({ d: "cached-test-project-line-that-would-wrap-in-grid", ts: Date.now() }),
    );
    localStorage.setItem(
      "wp-snap||another-project",
      JSON.stringify({ d: "cached-another-project-line-that-would-wrap-in-grid", ts: Date.now() }),
    );
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await page.waitForSelector("#desktop-grid-container .grid-cell canvas", { timeout: 5000 });

  const cachedVisibleBeforeHydration = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.some((cell) => cell.classList.contains("cached-visible") && !cell.classList.contains("hydrated")),
  );

  expect(cachedVisibleBeforeHydration).toBe(false);
});

test("grid viewport prefill does not seed cached prose into terminal scrollback", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    const cachedLines = Array.from({ length: 80 }, (_, idx) => `GRID-CACHED-SCROLLBACK-${idx}`).join("\n");
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: cachedLines, ts: Date.now() }));
    localStorage.setItem("wp-snap||another-project", JSON.stringify({ d: cachedLines, ts: Date.now() }));
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => !!gs.controller?.isConnected && gs._cellElement?.classList.contains("hydrated"));
  }), { timeout: 5000 }).toBe(true);

  const cells = await page.evaluate(() => {
    const w = window as unknown as {
      WP: { serializeBufferTail(buffer: unknown, maxLines: number): string };
      state: {
        gridSessions: Array<{
          session: string;
          controller?: { term?: { buffer?: { active?: unknown }; getScrollbackLength?: () => number } };
        }>;
      };
    };
    return w.state.gridSessions.map((gs) => {
      const term = gs.controller?.term;
      const buffer = term?.buffer?.active;
      return {
        session: gs.session,
        text: buffer ? w.WP.serializeBufferTail(buffer, 120) : "",
        scrollbackLength: term?.getScrollbackLength?.() ?? 0,
      };
    });
  });

  expect(cells).toHaveLength(2);
  for (const cell of cells) {
    expect(cell.text).not.toContain("GRID-CACHED-SCROLLBACK");
    expect(cell.scrollbackLength).toBeLessThan(10);
  }
});

test("grid output persists debounced recovery snapshots for every live cell", async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("INITIAL-GRID-SNAPSHOT\r\n"));
      ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await loadApp(page);

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    state.currentSession = "test-project";
    // @ts-ignore exposed by the browser bundle
    state.currentMachine = "";
    // @ts-ignore exposed by the browser bundle
    showView("terminal", true);
    // @ts-ignore exposed by the browser bundle
    addToGrid("another-project", "");
  });
  await expect.poll(() => sockets.length).toBe(2);
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.every((gs) => gs._cellElement?.classList.contains("hydrated"));
  })).toBe(true);

  sockets[0].send(Buffer.from("GRID-LIVE-SNAPSHOT-MARKER-0\r\n"));
  sockets[1].send(Buffer.from("GRID-LIVE-SNAPSHOT-MARKER-1\r\n"));

  await expect.poll(() => page.evaluate(() => {
    const first = localStorage.getItem("wp-snap||test-project") ?? "";
    const second = localStorage.getItem("wp-snap||another-project") ?? "";
    return first.includes("GRID-LIVE-SNAPSHOT-MARKER") && second.includes("GRID-LIVE-SNAPSHOT-MARKER");
  }), { timeout: 4_000 }).toBe(true);
});

test("grid viewport prefill timeout closes stalled sockets without revealing partial content", async ({ page }) => {
  const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  let attachCount = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      expect(parsed.prefillMode).toBe("viewport");
      attachCount++;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("PARTIAL-GRID-PREFILL-WITHOUT-DONE\r\n"));
      ws.send(JSON.stringify({ type: "prefill_viewport" }));
    });
    ws.onClose((code, reason) => {
      closes.push({ code, reason });
      void ws.close({ code, reason });
    });
  });
  await loadApp(page);
  await page.clock.install();

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    state.currentSession = "test-project";
    // @ts-ignore exposed by the browser bundle
    state.currentMachine = "";
    // @ts-ignore exposed by the browser bundle
    showView("terminal", true);
    // @ts-ignore exposed by the browser bundle
    addToGrid("another-project", "");
  });
  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell canvas").count()).toBe(2);
  await expect.poll(() => attachCount).toBe(2);

  await page.clock.fastForward(16_000);
  expect(closes.length).toBeGreaterThanOrEqual(2);
  for (const close of closes) {
    expect(close).toEqual({
      code: CLOSE_CODE_PREFILL_TIMEOUT,
      reason: WS_CLOSE_REASONS.PREFILL_TIMEOUT,
    });
  }

  const canvasStates = await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) =>
    canvases.map((canvas) => {
      const style = getComputedStyle(canvas);
      return { visibility: style.visibility, opacity: style.opacity };
    }),
  );
  expect(canvasStates).toEqual([
    { visibility: "hidden", opacity: "0" },
    { visibility: "hidden", opacity: "0" },
  ]);
});

test("new grid cells hide canvas until hydration completes", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await page.waitForSelector("#desktop-grid-container .grid-cell canvas", { timeout: 5000 });

  const earlyCanvasStates = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.map((cell) => {
      const canvas = cell.querySelector("canvas") as HTMLCanvasElement | null;
      const style = canvas ? getComputedStyle(canvas) : null;
      return {
        hydrating: cell.classList.contains("hydrating"),
        hydrated: cell.classList.contains("hydrated"),
        opacity: style?.opacity ?? "missing",
        visibility: style?.visibility ?? "missing",
      };
    }),
  );

  expect(earlyCanvasStates.length).toBeGreaterThan(0);
  for (const state of earlyCanvasStates) {
    if (!state.hydrated) {
      expect(state.hydrating).toBe(true);
      expect(state.opacity).toBe("0");
      expect(state.visibility).toBe("hidden");
    }
  }
});

test("grid manual retry hides stale content until replacement viewport prefill completes", async ({ page }) => {
  let attachCount = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      expect(parsed.prefillMode).toBe("viewport");
      attachCount++;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(attachCount <= 2 ? "INITIAL-GRID-PREFILL\r\n" : "REPLACEMENT-PARTIAL\r\n"));
      ws.send(JSON.stringify({ type: "prefill_viewport" }));
      if (attachCount <= 2) {
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      }
    });
  });
  await loadApp(page);

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    state.currentSession = "test-project";
    // @ts-ignore exposed by the browser bundle
    state.currentMachine = "";
    // @ts-ignore exposed by the browser bundle
    showView("terminal", true);
    // @ts-ignore exposed by the browser bundle
    addToGrid("another-project", "");
  });
  await expect.poll(() => attachCount).toBe(2);
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions.every((gs) => gs._cellElement?.classList.contains("hydrated"));
  })).toBe(true);

  await page.evaluate(() => {
    // Closing the existing client models the disconnected half of a displaced
    // cell before its take-control click creates a fresh socket client.
    // @ts-ignore exposed by the browser bundle
    state.gridSessions[0].controller.ptyClient.close();
  });
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.gridSessions[0].controller.isConnected;
  })).toBe(false);

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    state.gridSessions[0].controller.connect({ takeControl: true });
  });
  await expect.poll(() => attachCount).toBe(3);

  const replacementState = await page.locator("#desktop-grid-container .grid-cell").first().evaluate((cell) => {
    const canvas = cell.querySelector("canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      hydrating: cell.classList.contains("hydrating"),
      hydrated: cell.classList.contains("hydrated"),
      visibility: style?.visibility ?? "missing",
      opacity: style?.opacity ?? "missing",
    };
  });
  expect(replacementState).toEqual({
    hydrating: true,
    hydrated: false,
    visibility: "hidden",
    opacity: "0",
  });
});

test("viewport-only immediate layout-stable does not expose cached grid content", async ({ page }) => {
  const messages: Array<{ type?: string; prefillMode?: string; reason?: string }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; prefillMode?: string; reason?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      setTimeout(() => {
        messages.push({ type: "attach_ack" });
        ws.send(JSON.stringify({ type: "attach_ack" }));
      }, 50);
      setTimeout(() => ws.send(Buffer.from("GRID-VIEWPORT-PREFILL\n")), 2400);
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 2500);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 2510);
    });
  });

  await loadApp(page);
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpackLayoutStableDebugMode", "viewport-immediate-and-after-paint");
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "STALE-GRID-CACHED-PROSE", ts: Date.now() }));
    localStorage.setItem("wp-snap||another-project", JSON.stringify({ d: "STALE-GRID-CACHED-PROSE", ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore
    state.currentSession = "test-project";
    // @ts-ignore
    state.currentMachine = "";
    // @ts-ignore
    showView("terminal", true);
    // @ts-ignore
    addToGrid("another-project", "");
  });

  await page.waitForSelector("#desktop-grid-container .grid-cell canvas", { timeout: 5000 });

  const earlyStates = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.map((cell) => {
      const canvas = cell.querySelector("canvas") as HTMLCanvasElement | null;
      const style = canvas ? getComputedStyle(canvas) : null;
      return {
        cachedVisible: cell.classList.contains("cached-visible"),
        hydrating: cell.classList.contains("hydrating"),
        hydrated: cell.classList.contains("hydrated"),
        opacity: style?.opacity ?? "missing",
        visibility: style?.visibility ?? "missing",
      };
    }),
  );

  expect(earlyStates.length).toBeGreaterThanOrEqual(2);
  for (const state of earlyStates) {
    expect(state.cachedVisible).toBe(false);
    if (!state.hydrated) {
      expect(state.hydrating).toBe(true);
      expect(state.opacity).toBe("0");
      expect(state.visibility).toBe("hidden");
    }
  }

  await expect.poll(() => messages.filter((message) => message.type === "attach" && message.prefillMode === "viewport").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => messages.filter((message) => message.type === "layout_stable" && message.reason === "immediate").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const firstAckIndex = messages.findIndex((message) => message.type === "attach_ack");
  const firstImmediateIndex = messages.findIndex((message) => message.type === "layout_stable" && message.reason === "immediate");
  expect(firstImmediateIndex).toBeGreaterThan(-1);
  expect(firstAckIndex).toBeGreaterThan(firstImmediateIndex);

  await expect.poll(async () => page.evaluate(() => {
    // @ts-ignore
    return state.gridSessions.every((gs) => gs._cellElement?.classList.contains("hydrated"));
  }), { timeout: 5000 }).toBe(true);

  const cells = await page.evaluate(() => {
    const w = window as unknown as {
      WP: { serializeBufferTail(buffer: unknown, maxLines: number): string };
      state: {
        gridSessions: Array<{
          session: string;
          controller?: { term?: { buffer?: { active?: unknown } } };
        }>;
      };
    };
    return w.state.gridSessions.map((gs) => {
      const buffer = gs.controller?.term?.buffer?.active;
      return buffer ? w.WP.serializeBufferTail(buffer, 120) : "";
    });
  });
  expect(cells).toHaveLength(2);
  for (const text of cells) expect(text).not.toContain("STALE-GRID-CACHED-PROSE");
});

test("addToGrid from non-terminal view switches to terminal view first", async ({ page }) => {
  await loadApp(page);

  // Move to settings view so currentView !== "terminal"
  await page.evaluate(() => {
    // @ts-ignore
    showView("settings");
  });
  const viewBefore = await page.evaluate(() => {
    // @ts-ignore
    return state.currentView;
  });
  expect(viewBefore).toBe("settings");

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

test("removeFromGrid clears pending take-control timer", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    const w = window as unknown as {
      state: {
        currentView: string;
        currentSession: string;
        gridSessions: Array<unknown>;
        gridFocusIndex: number;
      };
      removeFromGrid: (idx: number) => void;
      __timerFired?: boolean;
    };
    w.__timerFired = false;
    w.state.currentView = "terminal";
    w.state.currentSession = "test-project";
    w.state.gridFocusIndex = 0;
    w.state.gridSessions = [
      {
        session: "test-project",
        machine: "",
        controller: { dispose() {}, isConnected: true },
        _takeControlTimer: window.setTimeout(() => { w.__timerFired = true; }, 50),
      },
      { session: "another-project", machine: "", controller: { dispose() {}, isConnected: true } },
    ];
    w.removeFromGrid(0);
  });

  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __timerFired?: boolean }).__timerFired)).toBe(false);
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
    showView("settings");
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

test("re-adding the remaining preserved session from settings reinitializes terminal view", async ({ page }) => {
  await loadApp(page);

  await page.evaluate(() => {
    // Start on settings with a suspended 2-session grid focused on another-project.
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
    showView("settings");
  });

  await page.evaluate(() => {
    // First click removes test-project from the preserved grid, leaving
    // another-project as the current single session.
    // @ts-ignore
    toggleGrid("test-project", "", null);
  });

  await page.evaluate(() => {
    // Second click re-adds the remaining current session from settings.
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

test("grid pty_ready clears stale prefill-loading state", async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

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
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string }> }>;
    };
    const traces = Object.values(debugWindow.__wfTrace || {});
    return ["test-project", "another-project"].every((session) =>
      traces.some((trace) => trace._meta.session === session && trace.events.some((event) => event.kind === "pty_ready")),
    );
  }), { timeout: 5000 }).toBe(true);

  const loadingStates = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.map((cell) => ({
      loadState: (cell as HTMLElement).dataset.terminalLoadState,
      slow: cell.classList.contains("terminal-load-slow"),
      slowLabel: (cell as HTMLElement).dataset.terminalSlowLabel,
    })),
  );

  for (const cell of loadingStates) {
    expect(cell.loadState).not.toBe("prefill-loading");
    expect(cell.slowLabel).not.toBe("waiting for grid cell prefill");
  }
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
