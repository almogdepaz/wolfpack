/**
 * Desktop grid navigation tests — covers the view-guard and suspend/resume paths
 * added for grid/navigation regressions.
 *
 * These tests drive grid state through rendered UI, DOM, and routed PTY frames.
 *
 * All tests require the desktop viewport (>768px) because grid controls are
 * desktop-only.
 */
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { gridSessionNames, openSessionFromUi, openSettingsFromUi, startTestServer, terminalTail, toggleSessionGridFromUi, type TestServer } from "./helpers.ts";
import { CLOSE_CODE_DISPLACED, CLOSE_CODE_PREFILL_TIMEOUT, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";
import { TAKE_CONTROL_FALLBACK_MS } from "../../public/take-control-coordinator.ts";

let srv: TestServer;

const THIRD_GRID_SESSION = "third-project";

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  await srv?.close();
});

// These are desktop-only behaviours
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "grid is desktop-only (isDesktop() requires width > 768)");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Navigate to the page and wait for the session cards to load. */
async function loadApp(page: Page): Promise<void> {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
}

async function openTerminal(page: Page, session = "test-project"): Promise<void> {
  await openSessionFromUi(page, session, "");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
}

async function openTwoCellGrid(page: Page): Promise<void> {
  await openTerminal(page, "test-project");
  await toggleSessionGridFromUi(page, "another-project", "");
  await expect(page.locator("#desktop-grid-container .grid-cell")).toHaveCount(2, { timeout: 5000 });
}

async function routeThirdGridSession(page: Page): Promise<void> {
  await page.route(`${srv.baseUrl}/api/sessions`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { readonly sessions: ReadonlyArray<Record<string, unknown>> };
    const template = body.sessions.find((session) => session.name === "another-project");
    if (!template) throw new Error("missing session template");
    const identity = template.identity as Record<string, unknown> | undefined;
    await route.fulfill({
      response,
      json: {
        sessions: [...body.sessions, {
          ...template,
          name: THIRD_GRID_SESSION,
          lastLine: "$ idle",
          ...(identity && {
            identity: {
              ...identity,
              wolfpackSessionId: "third-project-id",
              wolfpackSessionName: THIRD_GRID_SESSION,
            },
          }),
        }],
      },
    });
  });
}

async function routeHydratedPty(
  page: Page,
  ptyReadyGate?: Promise<void>,
  onViewportAttach?: () => void,
): Promise<Map<string, WebSocketRoute>> {
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
        onViewportAttach?.();
        ws.send(JSON.stringify({ type: "prefill_viewport" }));
      }
      ws.send(JSON.stringify({ type: "prefill_done" }));
      void Promise.resolve(ptyReadyGate).then(() => ws.send(JSON.stringify({ type: "pty_ready" })));
    });
  });
  return sockets;
}

type PtyClientMessage = {
  readonly type?: string;
  readonly prefillMode?: string;
  readonly takeControl?: boolean;
};

type PtyProtocolCounts = {
  readonly sockets: number;
  readonly attaches: number;
  readonly takeControls: number;
  readonly takeoverAttaches: number;
};

type TrackedPtyRoute = {
  readonly counts: (session: string) => PtyProtocolCounts;
};

async function routeTrackedHydratedPty(page: Page, conflictAfterReadySessions: readonly string[] = []): Promise<TrackedPtyRoute> {
  const sockets = new Map<string, WebSocketRoute[]>();
  const messages = new Map<string, PtyClientMessage[]>();
  const conflictedSessions = new Set(conflictAfterReadySessions);
  const sentConflicts = new Set<string>();
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    sockets.set(session, [...(sockets.get(session) ?? []), ws]);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as PtyClientMessage;
      messages.set(session, [...(messages.get(session) ?? []), parsed]);
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
      if (parsed.prefillMode === "viewport" && conflictedSessions.has(session) && !sentConflicts.has(session)) {
        sentConflicts.add(session);
        ws.send(JSON.stringify({ type: "viewer_conflict" }));
      }
    });
  });
  return {
    counts(session: string): PtyProtocolCounts {
      const sessionMessages = messages.get(session) ?? [];
      return {
        sockets: sockets.get(session)?.length ?? 0,
        attaches: sessionMessages.filter((message) => message.type === "attach").length,
        takeControls: sessionMessages.filter((message) => message.type === "take_control").length,
        takeoverAttaches: sessionMessages.filter((message) => message.type === "attach" && message.takeControl === true).length,
      };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("sub-session notification adds a child beside the active single parent", async ({ page }) => {
  const sockets = await routeHydratedPty(page);
  await loadApp(page);
  await openTerminal(page, "test-project");
  await expect.poll(() => sockets.has("test-project")).toBe(true);

  sockets.get("test-project")!.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));

  await expect.poll(() => gridSessionNames(page)).toEqual(["test-project", "another-project"]);
});

test("sub-session notification ignores other parents, views, and existing grids", async ({ page }) => {
  const sockets = await routeHydratedPty(page);
  await loadApp(page);
  await openTerminal(page, "test-project");
  await expect.poll(() => sockets.has("test-project")).toBe(true);
  let parentSocket = sockets.get("test-project")!;

  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "another-project",
    session: "third-project",
  }));
  await expect(page.locator("#desktop-grid-container .grid-cell")).toHaveCount(0);

  await openSettingsFromUi(page);
  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));
  await expect(page.locator("#desktop-grid-container .grid-cell")).toHaveCount(0);

  await openTerminal(page, "test-project");
  parentSocket = sockets.get("test-project")!;
  parentSocket.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "another-project",
  }));
  await expect.poll(() => gridSessionNames(page)).toEqual(["test-project", "another-project"]);

  await expect.poll(() => sockets.get("test-project")).not.toBeUndefined();
  sockets.get("test-project")!.send(JSON.stringify({
    type: "sub_session_opened",
    parentSession: "test-project",
    session: "third-project",
  }));
  await page.waitForTimeout(50);
  expect(await gridSessionNames(page)).toEqual(["test-project", "another-project"]);
});

test("grid requests viewport prefill", async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await openTwoCellGrid(page);

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

test("ctrl+arrow follows the rendered five-cell grid arrangement", async ({ page }) => {
  await routeThirdGridSession(page);
  await routeHydratedPty(page);
  await loadApp(page);

  await openTwoCellGrid(page);
  await toggleSessionGridFromUi(page, "prompt-project", "");
  await toggleSessionGridFromUi(page, "error-project", "");
  await toggleSessionGridFromUi(page, THIRD_GRID_SESSION, "");
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(5);

  const focusedSession = () => page.locator("#desktop-grid-container .grid-cell.grid-focused")
    .getAttribute("data-session");
  await expect.poll(focusedSession).toBe(THIRD_GRID_SESSION);

  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(focusedSession).toBe("prompt-project");
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(focusedSession).toBe("another-project");
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(focusedSession).toBe("error-project");
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(focusedSession).toBe("test-project");
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(focusedSession).toBe("test-project");
});

test("addToGrid from terminal view shows grid loading immediately", async ({ page }) => {
  await loadApp(page);

  await openTerminal(page, "test-project");
  await page.evaluate(() => {
    // Hold async terminal mount open so this checks the pre-mount gap that
    // used to expose stale/full-width terminal content before hydration began.
    (window as unknown as { ghosttyReady: Promise<never> }).ghosttyReady = new Promise<never>(() => {});
  });
  await toggleSessionGridFromUi(page, "another-project", "");

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

test("lazy renderer topology rerender keeps one controller per grid session", async ({ page }) => {
  await routeThirdGridSession(page);
  let releaseRenderer: () => void;
  const rendererHeld = new Promise<void>((resolve) => { releaseRenderer = resolve; });
  await page.route("**/ghostty-web.bundle.js*", async (route) => {
    const response = await route.fetch();
    const bundle = await response.text();
    await rendererHeld;
    await route.fulfill({
      response,
      body: `${bundle}\nwindow.__ghosttyGridTerminalCreations = 0;\nconst OriginalTerminal = window.Terminal;\nwindow.Terminal = class extends OriginalTerminal {\n  open(element) {\n    if (element.closest('.grid-cell')) window.__ghosttyGridTerminalCreations++;\n    return super.open(element);\n  }\n};`,
    });
  });

  const attachCounts = new Map<string, number>();
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      attachCounts.set(session, (attachCounts.get(session) ?? 0) + 1);
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await loadApp(page);
  await toggleSessionGridFromUi(page, "test-project", "");
  await toggleSessionGridFromUi(page, "another-project", "");
  // Re-render the two pending cells while the lazy renderer is unresolved.
  await toggleSessionGridFromUi(page, THIRD_GRID_SESSION, "");

  releaseRenderer!();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(3, { timeout: 5000 });

  expect(await page.locator("#desktop-grid-container .grid-cell").count()).toBe(3);
  expect(await page.evaluate(() => {
    return (window as unknown as { __ghosttyGridTerminalCreations: number }).__ghosttyGridTerminalCreations;
  })).toBe(3);
  expect([...attachCounts.entries()].sort()).toEqual([
    ["another-project", 1],
    ["test-project", 1],
    [THIRD_GRID_SESSION, 1],
  ]);
});

test("grid topology add hides existing canvases until relayout repaint completes", async ({ page }) => {
  await routeThirdGridSession(page);
  await routeHydratedPty(page);
  await loadApp(page);

  await openTwoCellGrid(page);

  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });

  const existingCells = page.locator("#desktop-grid-container .grid-cell");
  const thirdToggle = page.locator(`[data-action="toggle-grid"][data-session="${THIRD_GRID_SESSION}"]`).filter({ visible: true });
  const immediate = await thirdToggle.evaluate((control) => {
    (control as HTMLElement).click();
    const cells = [...document.querySelectorAll("#desktop-grid-container .grid-cell")];
    return cells.slice(0, 2).map((cell) => {
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

  await expect.poll(async () => existingCells.evaluateAll((cells) => cells.slice(0, 2).every((cell) => {
    const canvas = cell.querySelector("canvas");
    return !!canvas && !cell.classList.contains("transitioning") && getComputedStyle(canvas).visibility === "visible";
  })), { timeout: 5000 }).toBe(true);
});

test("grid topology add waits one frame after relayout repaint before revealing existing cells", async ({ page }) => {
  await routeThirdGridSession(page);
  await routeHydratedPty(page);
  await loadApp(page);

  await openTwoCellGrid(page);

  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });

  const thirdToggle = page.locator(`[data-action="toggle-grid"][data-session="${THIRD_GRID_SESSION}"]`).filter({ visible: true });
  const states = await thirdToggle.evaluate(async (control) => {
    (control as HTMLElement).click();
    const existing = [...document.querySelectorAll("#desktop-grid-container .grid-cell")].slice(0, 2);
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextFrame();
    await nextFrame();
    const afterRepaintRequestFrame = existing.map((cell) => cell.classList.contains("transitioning"));
    await nextFrame();
    const afterRevealFrame = existing.map((cell) => cell.classList.contains("transitioning"));
    return { afterRepaintRequestFrame, afterRevealFrame };
  });

  expect(states.afterRepaintRequestFrame).toEqual([true, true]);
  expect(states.afterRevealFrame).toEqual([false, false]);
});

test("addToGrid hides single terminal container before grid cells mount", async ({ page }) => {
  await loadApp(page);
  await openTerminal(page, "test-project");

  await page.evaluate(() => {
    // Hold async grid terminal mount open so this inspects the synchronous
    // single-terminal → grid transition gap.
    (window as unknown as { ghosttyReady: Promise<never> }).ghosttyReady = new Promise<never>(() => {});
  });
  await toggleSessionGridFromUi(page, "another-project", "");

  const immediateState = await page.evaluate(() => {
    const terminal = document.getElementById("desktop-terminal-container")!;
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

test("grid viewport prefill timeout closes stalled sockets without revealing partial content", async ({ page }) => {
  const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  let attachCount = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    let isViewportAttach = false;
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (parsed.prefillMode !== "viewport") {
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }
      isViewportAttach = true;
      attachCount++;
      ws.send(Buffer.from("PARTIAL-GRID-PREFILL-WITHOUT-DONE\r\n"));
      ws.send(JSON.stringify({ type: "prefill_viewport" }));
    });
    ws.onClose((code, reason) => {
      if (isViewportAttach) closes.push({ code, reason });
      void ws.close({ code, reason });
    });
  });
  await loadApp(page);
  await page.clock.install();

  await openTwoCellGrid(page);
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

  await openTwoCellGrid(page);

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
  for (const cellState of earlyCanvasStates) {
    if (!cellState.hydrated) {
      expect(cellState.hydrating).toBe(true);
      expect(cellState.opacity).toBe("0");
      expect(cellState.visibility).toBe("hidden");
    }
  }
});

test("grid viewer conflict exits hydration without becoming live", async ({ page }) => {
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session");
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      if (session === "another-project") {
        ws.send(JSON.stringify({ type: "viewer_conflict" }));
        return;
      }
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await loadApp(page);
  await openTerminal(page, "test-project");

  await toggleSessionGridFromUi(page, "another-project", "");

  const cell = page.locator('#desktop-grid-container .grid-cell[data-session="another-project"]');
  await expect(cell.locator(".viewer-conflict-overlay")).toBeVisible();
  const settledState = await cell.evaluate(async (element) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      hydrating: element.classList.contains("hydrating"),
      loadState: element.getAttribute("data-terminal-load-state"),
    };
  });
  expect(settledState).toEqual({ hydrating: false, loadState: "viewer-conflict" });
});

test("grid manual retry hides stale content until replacement viewport prefill completes", async ({ page }) => {
  let attachCount = 0;
  const viewportSockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (parsed.prefillMode !== "viewport") {
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }
      viewportSockets.push(ws);
      attachCount++;
      ws.send(Buffer.from(attachCount <= 2 ? "INITIAL-GRID-PREFILL\r\n" : "REPLACEMENT-PARTIAL\r\n"));
      ws.send(JSON.stringify({ type: "prefill_viewport" }));
      if (attachCount <= 2) {
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      }
    });
  });
  await loadApp(page);

  await openTwoCellGrid(page);
  await expect.poll(() => attachCount).toBe(2);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });

  await viewportSockets[0].close({ code: CLOSE_CODE_DISPLACED, reason: WS_CLOSE_REASONS.DISPLACED });
  await page.locator("#desktop-grid-container .grid-cell").first().locator(".viewer-conflict-overlay .conflict-btn").click();
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

test("viewport-only immediate layout-stable keeps grid canvases hidden until hydration", async ({ page }) => {
  const messages: Array<{ type?: string; prefillMode?: string; reason?: string }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    let tracksViewportAttach = false;
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; prefillMode?: string; reason?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type === "attach" && parsed.prefillMode !== "viewport") {
        ws.send(JSON.stringify({ type: "attach_ack" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }
      if (parsed.type === "attach") tracksViewportAttach = true;
      if (!tracksViewportAttach) return;
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
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await openTwoCellGrid(page);

  await page.waitForSelector("#desktop-grid-container .grid-cell canvas", { timeout: 5000 });

  const earlyStates = await page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
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

  expect(earlyStates.length).toBeGreaterThanOrEqual(2);
  for (const cellState of earlyStates) {
    if (!cellState.hydrated) {
      expect(cellState.hydrating).toBe(true);
      expect(cellState.opacity).toBe("0");
      expect(cellState.visibility).toBe("hidden");
    }
  }

  await expect.poll(() => messages.filter((message) => message.type === "attach" && message.prefillMode === "viewport").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => messages.filter((message) => message.type === "layout_stable" && message.reason === "immediate").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const firstAckIndex = messages.findIndex((message) => message.type === "attach_ack");
  const firstImmediateIndex = messages.findIndex((message) => message.type === "layout_stable" && message.reason === "immediate");
  expect(firstImmediateIndex).toBeGreaterThan(-1);
  expect(firstAckIndex).toBeGreaterThan(firstImmediateIndex);

  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });

  const cells = await Promise.all((await page.locator("#desktop-grid-container .grid-cell").all()).map((cell) => terminalTail(cell, 120)));
  expect(cells).toHaveLength(2);
  for (const text of cells) expect(text).toContain("GRID-VIEWPORT-PREFILL");
});

test("addToGrid from non-terminal view switches to terminal view first", async ({ page }) => {
  await loadApp(page);
  await openTerminal(page, "test-project");
  await openSettingsFromUi(page);
  await expect(page.locator("#settings-view")).toHaveClass(/visible/);

  await toggleSessionGridFromUi(page, "another-project", "");

  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

test("removing a conflicted grid cell prevents its scheduled takeover fallback", async ({ page }) => {
  await routeThirdGridSession(page);
  const controlSession = "test-project";
  const removedSession = "another-project";
  const stableSession = THIRD_GRID_SESSION;
  const protocol = await routeTrackedHydratedPty(page, [controlSession, removedSession]);
  await loadApp(page);
  await toggleSessionGridFromUi(page, controlSession, "");
  await toggleSessionGridFromUi(page, removedSession, "");
  await toggleSessionGridFromUi(page, stableSession, "");
  await expect.poll(() => gridSessionNames(page)).toEqual([controlSession, removedSession, stableSession]);

  const controlCell = page.locator(`#desktop-grid-container .grid-cell[data-session="${controlSession}"]`);
  const removedCell = page.locator(`#desktop-grid-container .grid-cell[data-session="${removedSession}"]`);
  await expect(controlCell.locator(".viewer-conflict-overlay")).toBeVisible({ timeout: 5000 });
  await expect(removedCell.locator(".viewer-conflict-overlay")).toBeVisible({ timeout: 5000 });

  const controlCountsBeforeTakeControl = protocol.counts(controlSession);
  await controlCell.locator(".viewer-conflict-overlay .conflict-btn").click();
  await removedCell.locator(".viewer-conflict-overlay .conflict-btn").click();
  await expect.poll(() => protocol.counts(controlSession).takeControls).toBe(1);
  await expect.poll(() => protocol.counts(removedSession).takeControls).toBe(1);

  await removedCell.getByRole("button", { name: `Remove ${removedSession} from grid` }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => gridSessionNames(page)).toEqual([controlSession, stableSession]);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
  const removedCountsAfterRemoval = protocol.counts(removedSession);
  const stableCountsAfterRemoval = protocol.counts(stableSession);
  expect(removedCountsAfterRemoval.takeoverAttaches).toBe(0);

  // External contract: removal may clear the timer or let the pending callback
  // self-disarm, but the removed session must not perform a takeover action.
  await page.waitForTimeout(TAKE_CONTROL_FALLBACK_MS + 500);

  const controlCountsAfterFallback = protocol.counts(controlSession);
  expect(controlCountsAfterFallback.sockets).toBe(controlCountsBeforeTakeControl.sockets + 1);
  expect(controlCountsAfterFallback.attaches).toBe(controlCountsBeforeTakeControl.attaches + 1);
  expect(controlCountsAfterFallback.takeoverAttaches).toBe(controlCountsBeforeTakeControl.takeoverAttaches + 1);
  expect(protocol.counts(removedSession)).toEqual(removedCountsAfterRemoval);
  expect(protocol.counts(stableSession)).toEqual(stableCountsAfterRemoval);
  await expect.poll(() => gridSessionNames(page)).toEqual([controlSession, stableSession]);
});

test("navigating away from terminal with active grid suspends grid state", async ({ page }) => {
  const protocol = await routeTrackedHydratedPty(page);
  await loadApp(page);
  await toggleSessionGridFromUi(page, "test-project", "");
  await toggleSessionGridFromUi(page, "another-project", "");
  await expect.poll(() => gridSessionNames(page)).toEqual(["test-project", "another-project"]);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
  const initialCounts = {
    testProject: protocol.counts("test-project"),
    anotherProject: protocol.counts("another-project"),
  };

  await openSettingsFromUi(page);

  await expect(page.locator("#settings-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-grid-container .grid-cell")).toHaveCount(0);

  await page.locator("#settings-back-btn").click();
  await expect.poll(() => gridSessionNames(page)).toEqual(["test-project", "another-project"]);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
  await expect.poll(() => protocol.counts("test-project").attaches).toBeGreaterThan(initialCounts.testProject.attaches);
  await expect.poll(() => protocol.counts("another-project").attaches).toBeGreaterThan(initialCounts.anotherProject.attaches);
  const tails = await Promise.all(["test-project", "another-project"].map((session) =>
    terminalTail(page.locator(`#desktop-grid-container .grid-cell[data-session="${session}"]`), 20),
  ));
  expect(tails).toEqual(expect.arrayContaining([expect.stringContaining("test-project-PREFILL"), expect.stringContaining("another-project-PREFILL")]));
});

test("transcript button clears grid-cell close controls", async ({ page }) => {
  await loadApp(page);
  await openTwoCellGrid(page);

  await expect(page.getByRole("button", { name: "Read session transcript" })).toHaveCSS("top", "40px");
});

test("re-adding the remaining preserved session from settings reinitializes terminal view", async ({ page }) => {
  await loadApp(page);
  await openTwoCellGrid(page);
  await openSettingsFromUi(page);

  await toggleSessionGridFromUi(page, "test-project", "");
  await toggleSessionGridFromUi(page, "another-project", "");

  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container")).toHaveCSS("display", "block");
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(1, { timeout: 5000 });
});

// ── Black-canvas regression: forceRepaint must fire after pty_ready ──────────
//
// Bug: grid cells render black until window resize/devtools-open. Single-terminal
// path was fixed in 75d6ff3 by calling forceRepaint() in onPtyReady. Grid path
// does not pass onPtyReady to createPtyTerminalController, so the manual
// #0a0a0a fillRect (app.ts:1006-1011) sticks until something forces a render.

test("addToGrid triggers forceRepaint per cell after pty_ready", async ({ page }) => {
  let releasePtyReady: () => void;
  let viewportAttaches = 0;
  const ptyReadyGate = new Promise<void>((resolve) => { releasePtyReady = resolve; });
  await routeHydratedPty(page, ptyReadyGate, () => { viewportAttaches += 1; });
  await loadApp(page);

  await openTwoCellGrid(page);
  await expect.poll(() => viewportAttaches).toBe(2);

  releasePtyReady!();

  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) =>
    canvases.every((canvas) => getComputedStyle(canvas).visibility === "visible"),
  )).toBe(true);
});

test("grid pty_ready clears stale prefill-loading state", async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await openTerminal(page, "test-project");

  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(1, { timeout: 5000 });

  await toggleSessionGridFromUi(page, "another-project", "");

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
  const attachCounts = new Map<string, number>();
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      attachCounts.set(session, (attachCounts.get(session) ?? 0) + 1);
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-RECONNECT-${attachCounts.get(session)}\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await loadApp(page);
  await openTwoCellGrid(page);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
  const initialAttachCounts = {
    testProject: attachCounts.get("test-project") ?? 0,
    anotherProject: attachCounts.get("another-project") ?? 0,
  };

  // Simulate >60s background: monkey-patch Date.now so the visibility handler
  // sees `hiddenDuration > 60_000` between the hidden/visible flip.
  await page.evaluate(() => {
    const origNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => origNow() + offset;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    offset = 70_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => [
    attachCounts.get("test-project") ?? 0,
    attachCounts.get("another-project") ?? 0,
  ], { timeout: 5000 }).toEqual([
    initialAttachCounts.testProject + 1,
    initialAttachCounts.anotherProject + 1,
  ]);
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 5000 });
});
