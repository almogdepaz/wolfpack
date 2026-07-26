import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

type WolfpackTestWindow = Window & {
  openSession(name: string, machineUrl?: string): void;
  addToGrid(name: string, machineUrl?: string): void;
  loadSessions(): Promise<void>;
  showProjectPicker(machineUrl?: string): void;
  showRalphStart(machineUrl?: string): void;
  showView(name: string): void;
  state: {
    currentSession?: string | null;
    activeDelegationRoot?: string | null;
    focusedDelegationSession?: string | null;
    gridSessions: Array<{ readonly session: string; readonly machine?: string; readonly controller?: unknown }>;
    preservedGridSessions: Array<{ readonly session: string; readonly machine?: string }>;
    delegationGridSessions: Array<{ readonly session: string; readonly controller?: unknown }>;
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
          { name: "wolfpack", lastLine: "parent", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity(parent.id, parent.name) },
          { name: "unrelated", lastLine: "root", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("broker-root", "unrelated") },
          { name: "wolfpack-sub-agent-2", lastLine: "child two", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("broker-child-2", "wolfpack-sub-agent-2", parent) },
          { name: "wolfpack-sub-agent", lastLine: "child one", triage: "idle", runtimeState: { state: "needs-input", unseen: true }, identity: identity("broker-child-1", "wolfpack-sub-agent", parent) },
          { name: "orphan-child", lastLine: "orphan", triage: "idle", runtimeState: { state: "working", unseen: true }, identity: identity("broker-orphan", "orphan-child", { id: "missing-parent", name: "gone <parent> & \"quoted\"" }) },
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
  await expect(cards.nth(0)).toContainText("2 children · 1 needs input · 1 idle");
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

  const childSidebarCard = page.locator("#sidebar-session-list .sub-session-card").first();
  await expect(childSidebarCard.locator(".delegation-parent-link")).toHaveCount(0);
  await page.locator("#sidebar-session-list .delegation-parent-card").first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");

  await childSidebarCard.locator(".grid-btn").click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as WolfpackTestWindow).state.gridSessions.some((entry) => entry.session === "wolfpack-sub-agent"),
  )).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");

  await page.evaluate(() => { window.confirm = () => true; });
  await childSidebarCard.locator(".kill-btn").click();
  await expect.poll(() => killRequests).toEqual([{ session: "wolfpack-sub-agent" }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as WolfpackTestWindow).state.currentSession)).toBe("wolfpack");
});

test("desktop opens and refreshes an ephemeral delegation grid without changing the manual grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid ux");

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
    { name: "manual-one", lastLine: "manual", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("manual-one-id", "manual-one") },
    { name: "manual-two", lastLine: "manual", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("manual-two-id", "manual-two") },
    { name: parent.name, lastLine: "coordinating", triage: "running", runtimeState: { state: "running", unseen: false }, identity: identity(parent.id, parent.name) },
    { name: "attention-child", lastLine: "waiting", triage: "idle", runtimeState: { state: "needs-input", unseen: true }, identity: identity("attention-child-id", "attention-child", parent) },
    { name: "idle-child", lastLine: "resting", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: identity("idle-child-id", "idle-child", parent) },
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
  await expect(page.locator("#delegation-grid-title")).toHaveText("delegation grid · delegation-parent");
  await expect(page.locator("#delegation-grid-summary")).toHaveText("2 children · 1 needs input · 1 idle");
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "idle-child",
  ]);
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as WolfpackTestWindow).state.preservedGridSessions.map(entry => entry.session))).toEqual([
    "manual-one",
    "manual-two",
  ]);

  await page.evaluate(() => {
    document.querySelector('#delegation-grid-container .grid-cell[data-session="attention-child"]')?.setAttribute("data-stability-marker", "same-cell");
  });
  await page.evaluate(() => (window as unknown as WolfpackTestWindow).loadSessions());
  await expect(page.locator('#delegation-grid-container .grid-cell[data-stability-marker="same-cell"]')).toHaveCount(1);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="attention-child"]')).not.toHaveClass(/transitioning/);

  await page.getByRole("button", { name: "Collapse idle child agents" }).click();
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="idle-child"]')).toHaveClass(/collapsed/);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-session="attention-child"]')).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => {
    const session = (window as unknown as WolfpackTestWindow).state.delegationGridSessions.find(entry => entry.session === "idle-child");
    return session?.controller == null;
  })).toBe(true);

  sessions = [
    ...sessions,
    { name: "new-child", lastLine: "working", triage: "running", runtimeState: { state: "working", unseen: true }, identity: identity("new-child-id", "new-child", parent) },
  ];
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "new-child",
    "idle-child",
  ], { timeout: 7_000 });

  sessions = sessions.filter(session => session.name !== "new-child");
  await expect(page.locator("#delegation-grid-shell")).toBeVisible();
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText([
    "delegation-parent",
    "attention-child",
    "idle-child",
  ], { timeout: 7_000 });

  await page.getByRole("button", { name: "exit grid" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as WolfpackTestWindow).state.gridSessions.map(entry => entry.session),
  )).toEqual(["manual-one", "manual-two"]);
});

test("desktop direct child focus suspends an active manual grid", async ({ page }, testInfo) => {
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
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          { name: "parent", triage: "idle", runtimeState: { state: "idle" }, identity: parent },
          { name: "child", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "child-id", wolfpackSessionName: "child", parentSession: parent } },
        ],
      }),
    });
  });
  await page.goto(srv.baseUrl);
  await page.evaluate(() => {
    (window as unknown as Window & { createIsolatedGhostty?: unknown; __gridAlert?: string }).createIsolatedGhostty = undefined;
    window.alert = (message?: string) => { (window as unknown as Window & { __gridAlert?: string }).__gridAlert = message ?? ""; };
  });

  await page.locator("#session-list .delegation-parent-card").click();

  await expect(page.locator("#delegation-grid-shell")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Window & { __gridAlert?: string }).__gridAlert,
  )).toContain("Grid mode is disabled");
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
  await page.getByRole("button", { name: "Back to delegation grid" }).click();
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText(["parent", "child"]);
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
  await expect(projectNameInput).toHaveAttribute("placeholder", "Project name");
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
        effective: { agentCmd: "shell", cmds: effectiveCommands.length > 0 ? effectiveCommands : ["shell"], ralphAgents: [] },
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
