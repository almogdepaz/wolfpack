import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

async function loadApp(page: Page): Promise<void> {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
}

async function createNamedView(page: Page, input: Record<string, unknown>): Promise<{ readonly id: string }> {
  return await page.evaluate(async (body) => {
    const res = await fetch("/api/named-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create named view failed: ${res.status}`);
    const data = await res.json() as { view: { id: string } };
    return { id: data.view.id };
  }, input);
}

async function listNamedViews(page: Page): Promise<Array<{ readonly id: string; readonly name: string; readonly members: unknown[] }>> {
  return await page.evaluate(async () => {
    const data = await (await fetch("/api/named-views")).json() as { views: Array<{ id: string; name: string; members: unknown[] }> };
    return data.views;
  });
}

async function openStaleTwoSlotNamedView(page: Page, name: string): Promise<void> {
  const view = await createNamedView(page, {
    name,
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "stale:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "stale:another-project" },
  });
  await page.evaluate(async (id) => {
    const w = window as unknown as {
      loadNamedViews: () => Promise<void>;
      openNamedViewById: (viewId: string) => Promise<void>;
    };
    await w.loadNamedViews();
    await w.openNamedViewById(id);
  }, view.id);
}

async function routeHydratedPty(page: Page): Promise<string[]> {
  const attaches: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws: WebSocketRoute) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    attaches.push(session);
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
  return attaches;
}

test("desktop saves the active grid and opens ordered stable views with unavailable non-PTY slots", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop named-view grid behavior");
  const attaches = await routeHydratedPty(page);
  await loadApp(page);

  await page.evaluate(() => {
    const w = window as unknown as {
      state: { currentSession: string; currentMachine: string };
      showView: (name: string, skip?: boolean) => void;
      addToGrid: (session: string, machine?: string) => void;
    };
    w.state.currentSession = "test-project";
    w.state.currentMachine = "";
    w.showView("terminal", true);
    w.addToGrid("another-project", "");
  });
  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell").count()).toBe(2);

  await page.evaluate(() => { window.prompt = () => "Release grid"; });
  await page.evaluate(async () => {
    const w = window as unknown as { saveNamedViewFromActiveGrid: () => Promise<void> };
    await w.saveNamedViewFromActiveGrid();
  });

  const saved = await page.evaluate(async () => {
    const data = await (await fetch("/api/named-views")).json() as { views: Array<{ name: string; members: unknown[]; focused?: unknown }> };
    return data.views.find((candidate) => candidate.name === "Release grid");
  });
  expect(saved).toMatchObject({
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "mock:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "mock:another-project" },
  });

  const unavailable = await createNamedView(page, {
    name: "Release stale",
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "stale:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "stale:another-project" },
  });
  attaches.length = 0;
  await page.evaluate(async (id) => {
    const w = window as unknown as {
      loadNamedViews: () => Promise<void>;
      openNamedViewById: (viewId: string) => Promise<void>;
    };
    await w.loadNamedViews();
    await w.openNamedViewById(id);
  }, unavailable.id);

  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as {
      state: {
        gridFocusIndex: number;
        gridSessions: Array<{ session: string; _namedViewUnavailable?: boolean; controller?: unknown }>;
      };
    };
    return {
      focusIndex: w.state.gridFocusIndex,
      sessions: w.state.gridSessions.map((entry) => ({
        session: entry.session,
        unavailable: !!entry._namedViewUnavailable,
        hasController: !!entry.controller,
      })),
    };
  })).toEqual({
    focusIndex: 1,
    sessions: [
      { session: "test-project", unavailable: false, hasController: true },
      { session: "another-project", unavailable: true, hasController: false },
    ],
  });
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-unavailable")).toHaveCount(1);
  expect(attaches).toEqual(["test-project"]);
});

test("foreground refreshes named views without a manual refresh control", async ({ page }) => {
  await loadApp(page);
  const unique = `Foreground ${Date.now()}`;
  await createNamedView(page, {
    name: unique,
    members: [{ machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" }],
  });

  const viewLabel = page.getByText(unique, { exact: true });
  await expect(viewLabel).toHaveCount(0);
  await expect(page.locator(`[onclick*="refreshNamedViews"]`)).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(viewLabel.first()).toBeVisible();
});

test("explicit update rebinds a replaced same-name session without weakening open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop named-view update behavior");
  const attaches = await routeHydratedPty(page);
  await loadApp(page);
  const unique = `Rebind ${Date.now()}`;
  const stale = await createNamedView(page, {
    name: unique,
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "stale:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "stale:another-project" },
  });
  await page.evaluate(async (id) => {
    const w = window as unknown as {
      loadNamedViews: () => Promise<void>;
      openNamedViewById: (viewId: string) => Promise<void>;
    };
    await w.loadNamedViews();
    await w.openNamedViewById(id);
  }, stale.id);

  await expect(page.locator("#desktop-grid-container .grid-cell.grid-unavailable")).toHaveCount(1);
  expect(attaches).toEqual(["test-project"]);
  await page.locator(`#desktop-sidebar .named-view-row[data-view-id="${stale.id}"] .named-view-btn`, { hasText: "update" }).click();
  await expect.poll(async () => {
    const updated = (await listNamedViews(page)).find((candidate) => candidate.id === stale.id);
    return updated?.members;
  }).toMatchObject([
    { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
    { machineUrl: "", sessionId: "mock:another-project", sessionName: "another-project" },
  ]);
  expect(attaches).toEqual(["test-project"]);
});

test("named-view unavailable slots survive suspend/restore without stale-name PTY attach", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop named-view grid lifecycle behavior");
  const attaches = await routeHydratedPty(page);
  await loadApp(page);
  await openStaleTwoSlotNamedView(page, "Lifecycle stale");
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-unavailable")).toHaveCount(1);

  attaches.length = 0;
  await page.evaluate(() => {
    const w = window as unknown as {
      state: { viewBeforeRalph: string };
      showView: (name: string, skip?: boolean) => void;
    };
    w.state.viewBeforeRalph = "terminal";
    w.showView("ralph-detail", true);
  });
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { state: { preservedGridSessions: Array<{ _namedViewUnavailable?: boolean; _namedViewSessionId?: string }> } };
    return w.state.preservedGridSessions.map((entry) => ({
      unavailable: !!entry._namedViewUnavailable,
      sessionId: entry._namedViewSessionId,
    }));
  })).toEqual([
    { unavailable: false, sessionId: "mock:test-project" },
    { unavailable: true, sessionId: "stale:another-project" },
  ]);

  await page.locator("#ralph-detail-view button.picker-cancel-btn").click();
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as {
      state: { gridSessions: Array<{ session: string; _namedViewUnavailable?: boolean; _namedViewSessionId?: string; controller?: unknown }> };
    };
    return w.state.gridSessions.map((entry) => ({
      session: entry.session,
      unavailable: !!entry._namedViewUnavailable,
      sessionId: entry._namedViewSessionId,
      hasController: !!entry.controller,
    }));
  })).toEqual([
    { session: "test-project", unavailable: false, sessionId: "mock:test-project", hasController: true },
    { session: "another-project", unavailable: true, sessionId: "stale:another-project", hasController: false },
  ]);
  expect(attaches).toEqual(["test-project"]);
});

test("removing the only live named-view member leaves no solo terminal attach", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop named-view grid collapse behavior");
  const attaches = await routeHydratedPty(page);
  await loadApp(page);
  await openStaleTwoSlotNamedView(page, "Collapse stale");
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-unavailable")).toHaveCount(1);

  attaches.length = 0;
  await page.evaluate(() => {
    const w = window as unknown as { removeFromGrid: (index: number) => void };
    w.removeFromGrid(0);
  });

  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as {
      state: { currentView: string; currentSession: string | null; gridSessions: unknown[]; terminalController?: unknown };
    };
    return {
      view: w.state.currentView,
      currentSession: w.state.currentSession,
      gridCount: w.state.gridSessions.length,
      hasTerminalController: !!w.state.terminalController,
    };
  })).toEqual({
    view: "sessions",
    currentSession: null,
    gridCount: 0,
    hasTerminalController: false,
  });
  expect(attaches).toEqual([]);
});

test("desktop update duplicate delete persists through reload and second page reopen", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop named-view CRUD behavior");
  await routeHydratedPty(page);
  await loadApp(page);
  const unique = `Crud ${Date.now()}`;
  const seeded = await createNamedView(page, {
    name: unique,
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "mock:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "mock:another-project" },
  });
  await page.evaluate(async () => {
    const w = window as unknown as { loadNamedViews: () => Promise<void> };
    await w.loadNamedViews();
  });

  await page.evaluate(() => {
    const w = window as unknown as {
      state: { currentSession: string; currentMachine: string };
      showView: (name: string, skip?: boolean) => void;
      addToGrid: (session: string, machine?: string) => void;
    };
    w.state.currentSession = "test-project";
    w.state.currentMachine = "";
    w.showView("terminal", true);
    w.addToGrid("prompt-project", "");
  });
  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell").count()).toBe(2);
  await page.locator(`#desktop-sidebar .named-view-row[data-view-id="${seeded.id}"] .named-view-btn`, { hasText: "update" }).click();
  await expect.poll(async () => {
    const updated = (await listNamedViews(page)).find((candidate) => candidate.id === seeded.id);
    return updated?.members;
  }).toMatchObject([
    { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
    { machineUrl: "", sessionId: "mock:prompt-project", sessionName: "prompt-project" },
  ]);

  await page.evaluate((copyName) => { window.prompt = () => copyName; }, `${unique} copy`);
  await page.locator(`#desktop-sidebar .named-view-row[data-view-id="${seeded.id}"] .named-view-btn`, { hasText: "dup" }).click();
  await expect.poll(async () => (await listNamedViews(page)).find((candidate) => candidate.name === `${unique} copy`)?.id).not.toBeUndefined();
  const copyId = (await listNamedViews(page)).find((candidate) => candidate.name === `${unique} copy`)!.id;

  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator(`#desktop-sidebar .named-view-row[data-view-id="${seeded.id}"] .danger`).click();
  await expect.poll(async () => (await listNamedViews(page)).some((candidate) => candidate.id === seeded.id)).toBe(false);

  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });
  await expect(page.locator("#desktop-sidebar .named-view-name", { hasText: `${unique} copy` })).toBeVisible();

  const secondPage = await context.newPage();
  const secondAttaches = await routeHydratedPty(secondPage);
  await loadApp(secondPage);
  await expect(secondPage.locator("#desktop-sidebar .named-view-name", { hasText: `${unique} copy` })).toBeVisible();
  await secondPage.locator(`#desktop-sidebar .named-view-row[data-view-id="${copyId}"] .named-view-open`).evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => secondPage.evaluate(() => {
    const w = window as unknown as { state: { gridSessions: Array<{ session: string }> } };
    return w.state.gridSessions.map((entry) => entry.session);
  })).toEqual(["test-project", "prompt-project"]);
  expect(secondAttaches.sort()).toEqual(["prompt-project", "test-project"]);
});

test("mobile renders named-view members in order and keeps unavailable members disabled", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile named-view list behavior");
  await routeHydratedPty(page);
  await loadApp(page);
  await createNamedView(page, {
    name: "Mobile release",
    members: [
      { machineUrl: "", sessionId: "mock:test-project", sessionName: "test-project" },
      { machineUrl: "", sessionId: "stale:another-project", sessionName: "another-project" },
    ],
    focused: { machineUrl: "", sessionId: "mock:test-project" },
  });

  await page.evaluate(async () => {
    const w = window as unknown as { loadNamedViews: () => Promise<void> };
    await w.loadNamedViews();
  });

  const mobileView = page.locator(".named-view-card", { hasText: "Mobile release" });
  await expect(mobileView.locator(".named-view-member")).toHaveText([
    /test-project[\s\S]*open/,
    /another-project[\s\S]*unavailable/,
  ]);
  await expect(mobileView.locator(".named-view-member").nth(1)).toHaveClass(/disabled/);

  await mobileView.locator(".named-view-member").first().click();
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { state: { currentView: string; currentSession: string } };
    return { view: w.state.currentView, session: w.state.currentSession };
  })).toEqual({ view: "terminal", session: "test-project" });
});
