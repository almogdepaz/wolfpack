import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

type WolfpackTestWindow = Window & {
  openSession(name: string, machineUrl?: string): void;
  addToGrid(name: string, machineUrl?: string): void;
  loadSessions(): Promise<void>;
  showProjectPicker(machineUrl?: string): void;
  showView(name: string): void;
  state: {
    currentSession?: string | null;
    activeDelegationRoot?: string | null;
    focusedDelegationSession?: string | null;
    gridSessions: Array<{ readonly session: string; readonly machine?: string; readonly controller?: unknown }>;
    preservedGridSessions: Array<{ readonly session: string; readonly machine?: string }>;
    delegationGridSessions: Array<{ readonly session: string; readonly controller?: unknown; readonly _collapsed?: boolean }>;
    sidebarAutoExpanded?: boolean;
    sidebarCollapsed?: boolean;
    sidebarPinned?: boolean;
  };
};

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

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
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  return sockets;
}

function observedRuntimeState(active: boolean) {
  return {
    state: active ? "output" : "idle",
    authority: "fallback",
    freshness: "fresh",
    source: "screen-fallback",
    stale: false,
    unseen: false,
  };
}

function structuredRuntimeState(state: "working" | "needs-input", unseen = false) {
  return {
    state,
    authority: "manifest",
    freshness: "fresh",
    source: "local-manifest",
    stale: false,
    unseen,
  };
}

function identity(id: string, name: string, parent?: { readonly id: string; readonly name: string }): {
  readonly wolfpackSessionId: string;
  readonly wolfpackSessionName: string;
  readonly parentSession?: {
    readonly wolfpackSessionId: string;
    readonly wolfpackSessionName: string;
  };
} {
  return {
    wolfpackSessionId: id,
    wolfpackSessionName: name,
    ...(parent && {
      parentSession: {
        wolfpackSessionId: parent.id,
        wolfpackSessionName: parent.name,
      },
    }),
  };
}

test("desktop opening delegation grid from auto-expanded sidebar collapses unpinned sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid ux");
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "0");
  });

  const parent = { id: "parent-id", name: "parent" };
  const sockets = await routeHydratedPty(page);
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "solo", lastLine: "solo", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("solo-id", "solo") },
          { name: parent.name, lastLine: "coordinating", triage: "running", runtimeState: { state: "running", unseen: false }, identity: identity(parent.id, parent.name) },
          { name: "child", lastLine: "waiting", triage: "idle", runtimeState: { state: "needs-input", unseen: true }, identity: identity("child-id", "child", parent) },
        ],
      }),
    });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("solo"));
  await expect.poll(() => sockets.has("solo")).toBe(true);

  const sidebar = page.locator("#desktop-sidebar");
  await expect(sidebar).toHaveClass(/collapsed/);
  await page.locator("#sidebar-hover-edge").dispatchEvent("mouseenter");
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.sidebarAutoExpanded)).toBe(true);

  await page.locator(`#sidebar-session-list .card[data-session-order-machine=""][data-session-order-id="${parent.id}"] .card-open`).click();
  await expect(page.locator("#delegation-grid-shell")).toBeVisible();

  expect(await page.evaluate(() => {
    const stateWindow = window as unknown as WolfpackTestWindow;
    return {
      sidebarClassCollapsed: document.getElementById("desktop-sidebar")?.classList.contains("collapsed") ?? false,
      sidebarAutoExpanded: stateWindow.state.sidebarAutoExpanded,
      sidebarCollapsed: stateWindow.state.sidebarCollapsed,
      sidebarPinned: stateWindow.state.sidebarPinned,
    };
  })).toEqual({
    sidebarClassCollapsed: true,
    sidebarAutoExpanded: false,
    sidebarCollapsed: true,
    sidebarPinned: false,
  });
});

test("desktop groups structured sub-agents directly under their parent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop parent-child session grouping");

  const identity = (id: string, name: string, parent?: { id: string; name: string }) => ({
    wolfpackSessionId: id,
    wolfpackSessionName: name,
    projectPath: "/repo/wolfpack",
    agentKind: "pi",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...(parent && {
      parentSession: {
        wolfpackSessionId: parent.id,
        wolfpackSessionName: parent.name,
      },
    }),
  });
  const parent = { id: "broker-parent", name: "wolfpack" };
  const killRequests: unknown[] = [];
  await page.route("**/api/kill", async (route) => {
    killRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "wolfpack", lastLine: "parent", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity(parent.id, parent.name) },
          { name: "unrelated", lastLine: "root", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity("broker-root", "unrelated") },
          { name: "wolfpack-sub-agent-2", lastLine: "child two", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity("broker-child-2", "wolfpack-sub-agent-2", parent) },
          { name: "wolfpack-sub-agent", lastLine: "child one", triage: "idle", runtimeState: structuredRuntimeState("needs-input", true), identity: identity("broker-child-1", "wolfpack-sub-agent", parent) },
          { name: "orphan-child", lastLine: "orphan", triage: "idle", runtimeState: structuredRuntimeState("working", true), identity: identity("broker-orphan", "orphan-child", { id: "missing-parent", name: "gone <parent> & \"quoted\"" }) },
        ],
      }),
    });
  });

  await page.goto(srv.baseUrl);

  const cards = page.locator("#session-list .card");
  await expect(cards).toHaveCount(5);
  await expect.poll(() => cards.locator(".card-name").evaluateAll((names) =>
    names.map((name) => name.firstChild?.textContent),
  )).toEqual([
    "wolfpack",
    "wolfpack-sub-agent",
    "wolfpack-sub-agent-2",
    "unrelated",
    "orphan-child",
  ]);
  await expect(cards.nth(0)).toContainText("2 children");
  await expect(cards.nth(0)).toHaveClass(/delegation-parent-card/);
  await expect(cards.nth(1)).toHaveClass(/sub-session-card/);
  await expect(cards.nth(1)).toHaveAttribute("data-parent-session", "wolfpack");
  await expect(cards.nth(1)).not.toContainText("parent: wolfpack");
  await expect(cards.nth(1).locator(".delegation-parent-link")).toHaveCount(0);
  await expect(cards.nth(2)).toHaveClass(/sub-session-card/);
  await expect(cards.nth(2)).toHaveAttribute("data-parent-session", "wolfpack");
  await expect(cards.nth(4)).toHaveClass(/orphan-session-card/);
  await expect(cards.nth(4)).toContainText("missing parent: gone <parent> & \"quoted\"");
  await expect(cards.nth(4).locator("script")).toHaveCount(0);

  await cards.nth(1).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack-sub-agent");

  const parentSidebarCard = page.locator("#sidebar-session-list .delegation-parent-card").first();
  const childSidebarCards = page.locator("#sidebar-session-list .sub-session-card");
  await expect(childSidebarCards).toHaveCount(0);
  await expect(parentSidebarCard.locator(".delegation-sidebar-toggle")).toHaveAccessibleName("Expand 2 child agents");
  await expect(parentSidebarCard.locator(".delegation-sidebar-toggle")).toHaveText(/2 agents$/);
  await parentSidebarCard.locator(".delegation-sidebar-toggle").click();
  await expect(childSidebarCards).toHaveCount(2);
  const childSidebarCard = childSidebarCards.first();
  await expect(childSidebarCard.locator(".delegation-parent-link")).toHaveCount(0);
  await parentSidebarCard.locator(".delegation-sidebar-toggle").click();
  await expect(childSidebarCards).toHaveCount(0);
  await parentSidebarCard.locator(".delegation-sidebar-toggle").click();
  await expect(childSidebarCards).toHaveCount(2);
  await parentSidebarCard.getByRole("button", { name: "Open wolfpack" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");

  await expect(childSidebarCard.locator(".grid-btn")).toHaveClass(/in-grid/);
  await childSidebarCard.locator(".grid-btn").click();
  await expect.poll(() => page.evaluate(() => {
    const session = (window as unknown as WolfpackTestWindow).state.delegationGridSessions.find(entry => entry.session === "wolfpack-sub-agent");
    return !!session?._collapsed;
  })).toBe(true);
  await expect(childSidebarCard.locator(".grid-btn")).not.toHaveClass(/in-grid/);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");

  await childSidebarCard.locator(".kill-btn").click();
  await page.getByRole("dialog", { name: "Stop session" }).getByRole("button", { name: "Stop session" }).click();
  await expect.poll(() => killRequests).toEqual([{ session: "wolfpack-sub-agent" }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");
});

test("desktop opens and refreshes an ephemeral delegation grid without changing the manual grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid ux");
  await page.setViewportSize({ width: 1500, height: 720 });
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "0");
  });

  const identity = (id: string, name: string, parent?: { id: string; name: string }) => ({
    wolfpackSessionId: id,
    wolfpackSessionName: name,
    ...(parent && {
      parentSession: {
        wolfpackSessionId: parent.id,
        wolfpackSessionName: parent.name,
      },
    }),
  });
  const parent = { id: "delegation-parent-id", name: "delegation-parent" };
  const sockets = await routeHydratedPty(page);
  let sessions = [
    { name: "manual-one", lastLine: "manual", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity("manual-one-id", "manual-one") },
    { name: "manual-two", lastLine: "manual", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity("manual-two-id", "manual-two") },
    { name: parent.name, lastLine: "coordinating", triage: "running", runtimeState: observedRuntimeState(true), identity: identity(parent.id, parent.name) },
    { name: "attention-child", lastLine: "waiting", triage: "idle", runtimeState: structuredRuntimeState("needs-input", true), identity: identity("attention-child-id", "attention-child", parent) },
    { name: "idle-child", lastLine: "resting", triage: "idle", runtimeState: observedRuntimeState(false), identity: identity("idle-child-id", "idle-child", parent) },
  ];
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("manual-one"));
  await expect.poll(() => sockets.has("manual-one")).toBe(true);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).addToGrid("manual-two"));
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session),
  )).toEqual(["manual-one", "manual-two"]);

  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("delegation-parent"));

  await expect(page.locator("#delegation-grid-shell")).toBeVisible();
  await expect(page.locator("#delegation-grid-title")).toHaveText("delegation-parent grid");
  await expect(page.locator("#delegation-grid-summary")).toHaveText("2 children");
  await expect(page.locator("#delegation-collapse-idle, #delegation-expand-all, #delegation-focus-parent, #delegation-exit-grid")).toHaveCount(0);
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "idle-child",
  ]);
  const sidebarCard = (name: string) => page.locator("#sidebar-session-list .card", { has: page.locator(".card-name", { hasText: name }) }).first();
  await page.locator("#sidebar-hover-edge").dispatchEvent("mouseenter");
  await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
  await expect(sidebarCard("delegation-parent").locator(".grid-btn")).toHaveClass(/in-grid/);
  await expect(sidebarCard("attention-child")).toHaveCount(0);
  await expect(sidebarCard("idle-child")).toHaveCount(0);
  await expect(sidebarCard("delegation-parent").locator(".delegation-sidebar-toggle")).toHaveAccessibleName("Expand 2 child agents");
  await sidebarCard("delegation-parent").locator(".delegation-sidebar-toggle").click();
  await expect(sidebarCard("attention-child").locator(".grid-btn")).toHaveClass(/in-grid/);
  await expect(sidebarCard("idle-child").locator(".grid-btn")).toHaveClass(/in-grid/);
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.preservedGridSessions.map(entry => entry.session))).toEqual([
    "manual-one",
    "manual-two",
  ]);

  const gridColumnCountBeforeSidebarHover = await page.evaluate(() => {
    const columns = getComputedStyle(document.getElementById("delegation-grid-container")!).gridTemplateColumns;
    return columns.split(" ").filter(Boolean).length;
  });
  expect(gridColumnCountBeforeSidebarHover).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => {
    const stateWindow = window as unknown as WolfpackTestWindow & {
      state: WolfpackTestWindow["state"] & { sidebarCollapsed: boolean; sidebarPinned: boolean; sessionsExpanded: boolean };
    };
    stateWindow.state.sidebarCollapsed = true;
    stateWindow.state.sidebarPinned = false;
    stateWindow.state.sessionsExpanded = false;
    document.body.classList.remove("sidebar-pinned", "sessions-expanded");
    document.getElementById("desktop-sidebar")?.classList.add("collapsed");
    document.getElementById("sidebar-hover-edge")?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await expect.poll(() => page.evaluate(() => {
    const columns = getComputedStyle(document.getElementById("delegation-grid-container")!).gridTemplateColumns;
    return columns.split(" ").filter(Boolean).length;
  })).toBe(gridColumnCountBeforeSidebarHover);

  await page.evaluate(() => {
    document.querySelector('#delegation-grid-container .grid-cell[data-session="attention-child"]')?.setAttribute("data-stability-marker", "same-cell");
  });
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).loadSessions());
  await expect(page.locator('#delegation-grid-container .grid-cell[data-stability-marker="same-cell"]')).toHaveCount(1);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="attention-child"]')).not.toHaveClass(/transitioning/);

  await page.locator('#delegation-grid-container .grid-cell[data-session="idle-child"] .delegation-cell-collapse').click();
  const collapsedIdleCell = page.locator('#delegation-grid-container .grid-cell[data-session="idle-child"]');
  await expect(collapsedIdleCell).toHaveClass(/collapsed/);
  await expect(collapsedIdleCell).toBeHidden();
  const collapsedIdleTab = page.getByRole("button", { name: "Expand idle-child" });
  await expect(collapsedIdleTab).toBeVisible();
  await expect(sidebarCard("idle-child").locator(".grid-btn")).not.toHaveClass(/in-grid/);
  await expect(sidebarCard("delegation-parent").locator(".grid-btn")).toHaveClass(/in-grid/);
  await expect(sidebarCard("attention-child").locator(".grid-btn")).toHaveClass(/in-grid/);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="attention-child"]')).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => {
    const session = (window as unknown as WolfpackTestWindow).state.delegationGridSessions.find(entry => entry.session === "idle-child");
    return session?.controller == null;
  })).toBe(true);
  await expect.poll(() => collapsedIdleTab.evaluate(button => getComputedStyle(button).boxShadow)).not.toBe("none");
  await collapsedIdleTab.click();
  await expect(collapsedIdleCell).not.toHaveClass(/collapsed/);
  await expect(collapsedIdleCell).toBeVisible();
  await expect(sidebarCard("idle-child").locator(".grid-btn")).toHaveClass(/in-grid/);
  await expect(collapsedIdleTab).toHaveCount(0);

  await page.locator("#sidebar-hover-edge").dispatchEvent("mouseenter");
  await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
  await sidebarCard("attention-child").locator(".grid-btn").click();
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="attention-child"]')).toHaveClass(/collapsed/);
  await expect(page.getByRole("button", { name: "Expand attention-child" })).toBeVisible();
  await expect(sidebarCard("attention-child").locator(".grid-btn")).not.toHaveClass(/in-grid/);
  await page.getByRole("button", { name: "Expand attention-child" }).click();
  await expect(sidebarCard("attention-child").locator(".grid-btn")).toHaveClass(/in-grid/);

  sessions = [
    ...sessions,
    { name: "new-child", lastLine: "working", triage: "running", runtimeState: structuredRuntimeState("working", true), identity: identity("new-child-id", "new-child", parent) },
  ];
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "idle-child",
    "new-child",
  ], { timeout: 7_000 });

  sessions = sessions.filter(session => session.name !== "new-child");
  await expect(page.locator("#delegation-grid-shell")).toBeVisible();
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "idle-child",
  ], { timeout: 7_000 });

  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.preservedGridSessions.map(entry => entry.session))).toEqual([
    "manual-one",
    "manual-two",
  ]);
});

test("desktop delegation focus makes suspended manual-grid sessions available to add", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation focus ux");

  const sockets = await routeHydratedPty(page);
  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "manual-one", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "manual-one-id", wolfpackSessionName: "manual-one" } },
          { name: "manual-two", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "manual-two-id", wolfpackSessionName: "manual-two" } },
          { name: "parent", triage: "idle", runtimeState: { state: "idle" }, identity: parent },
          { name: "child", triage: "running", runtimeState: { state: "working" }, identity: { wolfpackSessionId: "child-id", wolfpackSessionName: "child", parentSession: parent } },
        ],
      }),
    });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("manual-one"));
  await expect.poll(() => sockets.has("manual-one")).toBe(true);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).addToGrid("manual-two"));
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session),
  )).toEqual(["manual-one", "manual-two"]);

  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("child"));

  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(page.locator("#delegation-focus-label")).toHaveText("child terminal");
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.preservedGridSessions.map(entry => entry.session))).toEqual([
    "manual-one",
    "manual-two",
  ]);

  const manualOneCard = page.locator("#sidebar-session-list .card", {
    has: page.locator(".card-name", { hasText: "manual-one" }),
  }).first();
  const manualOneGridButton = manualOneCard.locator(".grid-btn");
  await expect(manualOneGridButton).not.toHaveClass(/in-grid/);
  await page.getByRole("button", { name: "Back to session grid" }).click();
  await expect(page.locator("#delegation-grid-shell")).toBeVisible();
  await expect(manualOneGridButton).not.toHaveClass(/in-grid/);
  await page.getByRole("button", { name: "Focus child" }).click();
  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(manualOneGridButton).not.toHaveClass(/in-grid/);
  await manualOneGridButton.click();

  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as WolfpackTestWindow;
    return {
      activeDelegationRoot: app.state.activeDelegationRoot,
      gridSessions: app.state.gridSessions.map(entry => entry.session),
      preservedGridSessions: app.state.preservedGridSessions.map(entry => entry.session),
    };
  })).toEqual({
    activeDelegationRoot: null,
    gridSessions: ["child", "manual-one"],
    preservedGridSessions: [],
  });

  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("child"));
  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).openSession("manual-one"));
  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as WolfpackTestWindow;
    return {
      activeDelegationRoot: app.state.activeDelegationRoot,
      currentSession: app.state.currentSession,
      preservedGridSessions: app.state.preservedGridSessions.map(entry => entry.session),
    };
  })).toEqual({
    activeDelegationRoot: null,
    currentSession: "manual-one",
    preservedGridSessions: [],
  });
  await expect(manualOneGridButton).not.toHaveClass(/in-grid/);
});

test("desktop delegation grid focus suspends hidden grid terminals", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid ux");

  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "parent", triage: "idle", runtimeState: { state: "idle" }, identity: parent },
          { name: "child", triage: "running", runtimeState: { state: "working" }, identity: { wolfpackSessionId: "child-id", wolfpackSessionName: "child", parentSession: parent } },
        ],
      }),
    });
  });
  await page.goto(srv.baseUrl);

  await page.locator("#session-list .delegation-parent-card").click();
  await page.getByRole("button", { name: "Focus child" }).click();

  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(page.locator("#delegation-focus-label")).toHaveText("child terminal");
  await expect(page.locator("#delegation-grid-container .grid-cell")).toHaveCount(0);
});

test("desktop delegation grid uses the same isolated terminal gate as manual grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid ux");

  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  const sockets = await routeHydratedPty(page);
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "solo", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "solo-id", wolfpackSessionName: "solo" } },
          { name: "parent", triage: "idle", runtimeState: { state: "idle" }, identity: parent },
          { name: "child", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "child-id", wolfpackSessionName: "child", parentSession: parent } },
        ],
      }),
    });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => {
    (window as unknown as WolfpackTestWindow).openSession("solo", "");
  });
  await expect.poll(() => sockets.has("solo")).toBe(true);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await page.evaluate(() => {
    (window as unknown as Window & { backToSessions(): void }).backToSessions();
    (window as unknown as Window & { createIsolatedGhostty?: unknown }).createIsolatedGhostty = undefined;
  });

  await page.locator("#session-list .delegation-parent-card").click();

  await expect(page.locator("#delegation-grid-shell")).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "Grid mode unavailable" })).toContainText("Grid mode is disabled");
});

test("desktop opens a child terminal with a return to its parent delegation grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation focus ux");

  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "parent", triage: "idle", runtimeState: { state: "idle" }, identity: parent },
          {
            name: "child",
            triage: "running",
            runtimeState: { state: "working" },
            identity: {
              wolfpackSessionId: "child-id",
              wolfpackSessionName: "child",
              parentSession: parent,
            },
          },
        ],
      }),
    });
  });
  await page.goto(srv.baseUrl);

  await page.locator("#session-list .sub-session-card").click();

  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(page.locator("#delegation-focus-label")).toHaveText("child terminal");
  await expect(page.locator("#delegation-grid-container .grid-cell")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to session grid" }).click();
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText(["parent", "child"]);
});

test("desktop stopping a focused child returns to its parent instead of session cards", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation focus ux");

  const parent = { id: "parent-id", name: "parent" };
  const parentSession = {
    name: parent.name,
    triage: "idle",
    runtimeState: { state: "idle" },
    identity: identity(parent.id, parent.name),
  };
  let sessions = [
    parentSession,
    {
      name: "child",
      triage: "running",
      runtimeState: { state: "working" },
      identity: identity("child-id", "child", parent),
    },
  ];
  const killRequests: unknown[] = [];
  const sockets = await routeHydratedPty(page);
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) });
  });
  await page.route("**/api/kill", async (route) => {
    killRequests.push(route.request().postDataJSON());
    sessions = [parentSession];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(srv.baseUrl);

  await page.locator("#session-list .sub-session-card").click();
  await expect(page.locator("#delegation-focus-label")).toHaveText("child terminal");
  await page.locator("#sidebar-hover-edge").dispatchEvent("mouseenter");
  const parentSidebarCard = page.locator('#sidebar-session-list .delegation-parent-card[data-session-order-machine=""]');
  await parentSidebarCard.locator(".delegation-sidebar-toggle").click();
  const childSidebarCard = page.locator('#sidebar-session-list .sub-session-card[data-session-order-machine=""]');
  await childSidebarCard.locator(".kill-btn").click();
  await page.getByRole("dialog", { name: "Stop session" }).getByRole("button", { name: "Stop session" }).click();

  await expect.poll(() => killRequests).toEqual([{ session: "child" }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("parent");
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.locator("#sessions-view")).not.toHaveClass(/visible/);
  await expect.poll(() => sockets.has("parent")).toBe(true);
});

test("project picker filters fetched projects by typed prefix without refetching", async ({ page }) => {
  let projectRequests = 0;
  await page.route("**/api/projects", async (route) => {
    projectRequests++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: ["loom", "LoopTools", "catalog", "LOOKOUT"] }),
    });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  const projectNameInput = page.locator("#new-project-name");
  await expect(projectNameInput).toBeFocused();
  await expect(projectNameInput).toHaveAttribute("placeholder", "Filter existing projects");
  const projectNames = page.locator("#project-list .card-name");
  await expect(projectNames).toHaveText(["loom", "LoopTools", "catalog", "LOOKOUT"]);

  await projectNameInput.fill("loo");
  await expect(projectNames).toHaveText(["loom", "LoopTools", "LOOKOUT"]);
  expect(projectRequests).toBe(1);

  await projectNameInput.fill("log");
  await expect(projectNames).toHaveCount(0);
  await expect(page.locator("#project-list")).toHaveText("No matching projects");

  await projectNameInput.fill("  ");
  await expect(projectNames).toHaveText(["loom", "LoopTools", "catalog", "LOOKOUT"]);
  expect(projectRequests).toBe(1);

  await projectNameInput.fill("LOOPT");
  await page.locator("#project-list .card").click();
  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
});

test("project picker uses concise labels without repeating placeholders", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());

  await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  await expect(page.locator("#new-project-name")).toHaveAttribute("placeholder", "Filter existing projects");
  await expect(page.getByText("Open existing directory", { exact: true })).toBeVisible();
  await expect(page.locator("#existing-project-dir")).toHaveAttribute("placeholder", "/absolute/path/to/project");
  await expect(page.getByRole("button", { name: "Open existing directory", exact: true })).toHaveText("Open");
  await expect(page.getByText("Create a project", { exact: true })).toBeVisible();
  await expect(page.locator("#new-project-create-name")).toHaveAttribute("placeholder", "Project name");
  await expect(page.getByRole("button", { name: "Create new project", exact: true })).toHaveText("Create");
});

test("project picker preserves exact explicit server directory text in browser requests", async ({ page }) => {
  const projectDir = "/srv/worktrees/path with spaces ";
  const nextNameQueries: URL[] = [];
  const createRequests: Array<Record<string, unknown>> = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["pi"], agentCmd: "pi" } }),
    });
  });
  await page.route(/\/api\/next-session-name\?/, async (route) => {
    nextNameQueries.push(new URL(route.request().url()));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "path_with_spaces" }) });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, session: "path_with_spaces" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await page.locator("#existing-project-dir").fill(projectDir);
  await page.getByRole("button", { name: "Open existing directory", exact: true }).click();
  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
  await expect(page.locator("#session-name-input")).toHaveValue("path_with_spaces");
  await page.getByRole("button", { name: "Start pi", exact: true }).click();

  expect(nextNameQueries).toHaveLength(1);
  expect(nextNameQueries[0].searchParams.get("projectDir")).toBe(projectDir);
  expect(nextNameQueries[0].searchParams.has("project")).toBe(false);
  await expect.poll(() => createRequests).toEqual([{
    projectDir,
    cmd: "pi",
    sessionName: "path_with_spaces",
  }]);
});

test("project picker promptly surfaces directory validation while agent settings remain pending", async ({ page }) => {
  const validationError = "project directory not found";
  let settingsRequested = false;
  let releaseSettings: () => void = () => {};
  const settingsPending = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    settingsRequested = true;
    await settingsPending;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["pi"], agentCmd: "pi" } }),
    });
  });
  await page.route(/\/api\/next-session-name\?/, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: validationError }),
    });
  });

  try {
    await page.goto(srv.baseUrl);
    await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
    await page.locator("#existing-project-dir").fill("/srv/worktrees/missing");
    await page.getByRole("button", { name: "Open existing directory", exact: true }).click();

    await expect.poll(() => settingsRequested, { timeout: 2_000 }).toBe(true);
    await expect(page.locator("#agent-list")).toHaveText(validationError, { timeout: 2_000 });
    await expect(page.locator("#agent-list")).not.toContainText("Failed to load agents");
  } finally {
    releaseSettings();
  }
});

test("project creation input and action stay the same height", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());

  const inputBox = await page.locator("#new-project-create-name").boundingBox();
  const buttonBox = await page.getByRole("button", { name: "Create new project", exact: true }).boundingBox();
  expect(inputBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(Math.abs((inputBox?.height ?? 0) - (buttonBox?.height ?? 0))).toBeLessThanOrEqual(1);
});

test("desktop project picker keeps a large catalog scrollable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop project picker layout");
  const projects = Array.from({ length: 41 }, (_, index) => `project-${String(index).padStart(2, "0")}`);
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());

  const projectList = page.locator("#project-list");
  await expect(projectList.locator(".card")).toHaveCount(projects.length);
  const dimensions = await projectList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
});

test("desktop project picker cards retain a practical target size", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop project picker layout");
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["wolfpack"] }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());

  const cardBox = await page.locator("#project-list .card").boundingBox();
  expect(cardBox?.height).toBeGreaterThanOrEqual(44);
});

test("enter in project search never creates a directory", async ({ page }) => {
  const selectedProjects: string[] = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha"] }) });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    const project = new URL(route.request().url()).searchParams.get("project");
    if (project) selectedProjects.push(project);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "brand-new" }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ effective: { cmds: ["shell"] } }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  const search = page.locator("#new-project-name");
  await search.fill("brand-new");
  await search.press("Enter");

  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  expect(selectedProjects).toEqual([]);
  await page.getByLabel("Create a project").fill("brand-new");
  await page.getByRole("button", { name: "Create new project" }).click();
  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
  expect(selectedProjects).toEqual(["brand-new"]);
});

test("desktop new-session pickers use arrow navigation only after it starts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard navigation");
  const createRequests: unknown[] = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha", "beta"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["shell", "pi"], agentCmd: "shell" } }),
    });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "alpha-session" }) });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: "alpha-session" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  const projectCards = page.locator("#project-list .card");
  await expect(projectCards).toHaveText(["alpha", "beta"]);
  await expect(page.locator("#project-list .card.keyboard-selected")).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(projectCards.nth(0)).toHaveClass(/keyboard-selected/);
  await page.keyboard.press("ArrowDown");
  await expect(projectCards.nth(1)).toHaveClass(/keyboard-selected/);
  await page.keyboard.press("ArrowUp");
  await expect(projectCards.nth(0)).toHaveClass(/keyboard-selected/);
  await page.keyboard.press("Enter");

  const agentCards = page.locator("#agent-list .card");
  await expect(agentCards).toHaveText(["shell", "pi"]);
  await expect(page.locator("#agent-list .card.keyboard-selected")).toHaveCount(0);
  await expect(page.locator("#initial-task-input")).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await expect(agentCards.nth(1)).toHaveClass(/keyboard-selected/);
  await page.keyboard.press("Enter");
  await expect.poll(() => createRequests).toEqual([{
    project: "alpha",
    cmd: "pi",
    sessionName: "alpha-session",
  }]);
});

test("desktop selects a filtered project instead of creating its typed prefix", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard navigation");
  const selectedProjects: string[] = [];
  const createRequests: unknown[] = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha", "wolfpack"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }) });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    const project = new URL(route.request().url()).searchParams.get("project");
    if (project) selectedProjects.push(project);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "wolfpack-session" }) });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: "wolfpack-session" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await page.locator("#new-project-name").fill("wo");
  const projectCards = page.locator("#project-list .card");
  await expect(projectCards).toHaveText(["wolfpack"]);
  await page.keyboard.press("ArrowDown");
  await expect(projectCards.nth(0)).toHaveClass(/keyboard-selected/);
  await page.keyboard.press("Enter");
  await expect.poll(() => selectedProjects).toEqual(["wolfpack"]);

  await page.locator("#agent-list .card", { hasText: "shell" }).click();
  await expect.poll(() => createRequests).toEqual([{ project: "wolfpack", cmd: "shell", sessionName: "wolfpack-session" }]);
});

test("click selects a filtered project through final create", async ({ page }) => {
  const createRequests: unknown[] = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha", "wolfpack"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }) });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "wolfpack-session" }) });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: "wolfpack-session" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await page.locator("#new-project-name").fill("wo");
  const projectCards = page.locator("#project-list .card");
  await expect(projectCards).toHaveText(["wolfpack"]);
  await projectCards.first().click();

  await page.locator("#agent-list .card", { hasText: "shell" }).click();
  await expect.poll(() => createRequests).toEqual([{ project: "wolfpack", cmd: "shell", sessionName: "wolfpack-session" }]);
});

test("desktop enter selects the first filtered project without arrow navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard navigation");
  const selectedProjects: string[] = [];
  const createRequests: unknown[] = [];
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["alpha", "wolfpack", "wolfpack-tools"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }) });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    const project = new URL(route.request().url()).searchParams.get("project");
    if (project) selectedProjects.push(project);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "wolfpack-session" }) });
  });
  await page.route("**/api/create", async (route) => {
    createRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: "wolfpack-session" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await page.locator("#new-project-name").fill("wo");
  await expect(page.locator("#project-list .card")).toHaveText(["wolfpack", "wolfpack-tools"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => selectedProjects).toEqual(["wolfpack"]);

  await page.locator("#agent-list .card", { hasText: "shell" }).click();
  await expect.poll(() => createRequests).toEqual([{ project: "wolfpack", cmd: "shell", sessionName: "wolfpack-session" }]);
});

test("create failure returns to the agent form with the entered session name and an inline error", async ({ page }) => {
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: ["wolfpack"] }) });
  });
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ effective: { cmds: ["shell"], agentCmd: "shell" } }),
    });
  });
  await page.route(/\/api\/next-session-name\?project=/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "wolfpack-session" }) });
  });
  await page.route("**/api/create", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "broker unavailable" }) });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showProjectPicker());
  await page.getByRole("button", { name: "Open project wolfpack" }).click();
  const sessionName = page.locator("#session-name-input");
  await sessionName.fill("my-session");
  await page.getByRole("button", { name: "Start shell" }).click();

  await expect(page.locator("#agent-view")).toHaveClass(/visible/);
  await expect(sessionName).toHaveValue("my-session");
  await expect(page.locator("#agent-create-error")).toContainText("broker unavailable");
  await expect(sessionName).toBeFocused();
});

test("stop confirmation is styled, cancellable, and restores focus", async ({ page }) => {
  const killRequests: unknown[] = [];
  await page.route("**/api/kill", async (route) => {
    killRequests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(srv.baseUrl);
  const stop = page.getByRole("button", { name: "Stop test-project" });
  await stop.focus();
  await stop.click();

  const dialog = page.getByRole("dialog", { name: "Stop session" });
  await expect(dialog).toContainText('Stop session "test-project"?');
  expect(await dialog.evaluate((element) => {
    const title = element.querySelector("h2");
    const cancel = element.querySelector<HTMLButtonElement>("#app-dialog-cancel");
    const confirm = element.querySelector<HTMLButtonElement>("#app-dialog-confirm");
    if (!title || !cancel || !confirm) throw new Error("missing dialog controls");
    const titleStyle = getComputedStyle(title);
    const cancelStyle = getComputedStyle(cancel);
    const confirmStyle = getComputedStyle(confirm);
    return {
      titleColor: titleStyle.color,
      titleTransform: titleStyle.textTransform,
      cancelBackground: cancelStyle.backgroundColor,
      cancelBorderRadius: cancelStyle.borderRadius,
      cancelTransform: cancelStyle.textTransform,
      confirmBackground: confirmStyle.backgroundColor,
      confirmBorderRadius: confirmStyle.borderRadius,
      confirmTransform: confirmStyle.textTransform,
    };
  })).toEqual({
    titleColor: "rgb(0, 255, 65)",
    titleTransform: "uppercase",
    cancelBackground: "rgb(26, 26, 26)",
    cancelBorderRadius: "6px",
    cancelTransform: "uppercase",
    confirmBackground: "rgba(204, 51, 51, 0.12)",
    confirmBorderRadius: "6px",
    confirmTransform: "uppercase",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(stop).toBeFocused();
  expect(killRequests).toEqual([]);
});

test("desktop escape from new-session picker returns to expanded sessions, not an empty terminal",  async ({ page }, testInfo) => {
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

test("offline Tailnet candidates stay out of workspace navigation but remain in settings inventory", async ({ page }, testInfo) => {
  let candidateRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-machines", JSON.stringify([
      { name: "Offline one", url: "https://offline-one.example.ts.net" },
      { name: "Offline two", url: "https://offline-two.example.ts.net" },
    ]));
  });
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    candidateRequests++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "offline-one.example.ts.net", tailnetNodeId: "n-offline-one", origin: "https://offline-one.example.ts.net", online: false },
        { hostname: "offline-two.example.ts.net", tailnetNodeId: "n-offline-two", origin: "https://offline-two.example.ts.net", online: false },
      ] }),
    });
  });

  await page.goto(srv.baseUrl);
  const remoteGroups = page.locator('#session-list .machine-group[data-machine^="candidate:n-offline-"]');
  await expect(remoteGroups).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    await expect(page.locator('#sidebar-session-list .machine-group[data-machine^="candidate:n-offline-"]')).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Settings" }).click();
  const machines = page.locator("#machines-list .machine-item");
  await expect(machines).toHaveCount(2);
  await expect(machines.nth(0)).toContainText("Offline one");
  await expect(machines.nth(0).locator(".dot")).toHaveAttribute("title", "tailnet reports this peer offline");
  await expect(machines.nth(1)).toContainText("Offline two");
  await expect(machines.nth(1).locator(".dot")).toHaveAttribute("title", "tailnet reports this peer offline");
  expect(candidateRequests).toBeGreaterThan(0);
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

test("settings shows provider readiness and adds an installed provider", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop provider readiness");

  let configuredCommands = [{ cmd: "shell", enabled: true }];
  const updateBodies: unknown[] = [];
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { addCmd?: string; removeCmd?: string };
      updateBodies.push(body);
      if (body.addCmd && !configuredCommands.some((entry) => entry.cmd === body.addCmd)) {
        configuredCommands = [...configuredCommands, { cmd: body.addCmd, enabled: true }];
      }
      if (body.removeCmd) {
        configuredCommands = configuredCommands.filter((entry) => entry.cmd !== body.removeCmd);
      }
    }
    const effectiveCommands = configuredCommands.filter((entry) => entry.enabled).map((entry) => entry.cmd);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        settings: { agentCmd: "shell", cmds: configuredCommands },
        effective: { agentCmd: "shell", cmds: effectiveCommands.length > 0 ? effectiveCommands : ["shell"] },
      }),
    });
  });
  await page.route("**/api/providers", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            command: "codex",
            status: "installed",
            executablePath: "/opt/homebrew/bin/codex",
            version: "codex-cli 7.6.5",
            authStatus: "unknown",
            loginCommand: "codex login",
          },
          {
            id: "gemini",
            displayName: "Gemini CLI",
            command: "gemini",
            status: "missing",
            installGuidance: "npm install -g @google/gemini-cli",
          },
        ],
      }),
    });
  });

  await page.goto(srv.baseUrl);
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).showView("settings"));
  await expect(page.locator("#setting-snapshotTtl")).toHaveCount(0);

  const shellRow = page.locator("#agents-list .agent-row").filter({ hasText: "shell" });
  await expect(shellRow.locator(".agent-row-checkbox")).toBeEnabled();
  await expect(shellRow.locator(".agent-row-delete")).toHaveCount(1);

  const shell = page.locator('[data-provider-id="shell"]');
  await expect(shell.getByRole("button", { name: "Shell added" })).toBeDisabled();
  await shellRow.locator(".agent-row-delete").click();
  expect(updateBodies).toEqual([{ removeCmd: "shell" }]);
  await shell.getByRole("button", { name: "Add Shell" }).click();
  expect(updateBodies).toEqual([{ removeCmd: "shell" }, { addCmd: "shell" }]);
  await expect(shell.getByRole("button", { name: "Shell added" })).toBeDisabled();

  const codex = page.locator('[data-provider-id="codex"]');
  await expect(codex).toContainText("Codex");
  await expect(codex).toContainText("codex-cli 7.6.5");
  await expect(codex).toContainText("auth unknown");
  await expect(codex).toContainText("codex login");
  const gemini = page.locator('[data-provider-id="gemini"]');
  await expect(gemini).toContainText("missing");
  await expect(gemini).toContainText("npm install -g @google/gemini-cli");

  await codex.getByRole("button", { name: "Add Codex" }).click();

  expect(updateBodies).toEqual([
    { removeCmd: "shell" },
    { addCmd: "shell" },
    { addCmd: "codex" },
  ]);
  await expect(codex.getByRole("button", { name: "Codex added" })).toBeDisabled();
  await expect(page.locator("#agents-list")).toContainText("codex");
});
