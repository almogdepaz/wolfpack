import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

const PEER_ORIGIN = "https://idle-peer.example.ts.net";
const PEER_INSTALLATION_ID = "f9ae7025-30ad-4461-bc57-365431dbf00c";
const PEER_IDENTITY = `n-idle-peer:${PEER_INSTALLATION_ID}`;

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

function fallbackRuntimeState(state: "idle" | "output") {
  return {
    state,
    authority: "fallback",
    freshness: "fresh",
    source: "screen-fallback",
    stale: false,
  };
}

function manifestRuntimeState(state: "working" | "needs-input" | "done" | "failed" | "idle", unseen = false) {
  return {
    state,
    authority: "manifest",
    freshness: "fresh",
    source: "local-manifest",
    stale: false,
    unseen,
    transitionSequence: 7,
    observedAt: "2026-10-01T12:00:00.000Z",
    changedAt: "2026-10-01T11:59:00.000Z",
    message: "Operator decision required <not HTML>",
  };
}

function session(
  name: string,
  runtimeState: ReturnType<typeof fallbackRuntimeState> | ReturnType<typeof manifestRuntimeState>,
  options: {
    readonly triage?: "idle" | "running";
    readonly parent?: { readonly id: string; readonly name: string };
  } = {},
) {
  const id = `${name}-id`;
  return {
    name,
    lastLine: `${name} preview`,
    triage: options.triage ?? "idle",
    runtimeState,
    identity: {
      wolfpackSessionId: id,
      wolfpackSessionName: name,
      ...(options.parent && {
        parentSession: {
          wolfpackSessionId: options.parent.id,
          wolfpackSessionName: options.parent.name,
        },
      }),
    },
  };
}

type FixtureSession = ReturnType<typeof session>;

interface SessionFixture {
  setLocalSessions(sessions: FixtureSession[]): void;
  sessionRequestCount(): number;
}

async function installSessionFixture(
  page: Page,
  initial: {
    readonly localSessions: FixtureSession[];
    readonly peerSessions?: FixtureSession[];
  },
): Promise<SessionFixture> {
  let localSessions = initial.localSessions;
  let peerSessions = initial.peerSessions ?? [];
  let requestCount = 0;
  const includePeer = initial.peerSessions !== undefined;

  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: includePeer ? [{
        hostname: "idle-peer.example.ts.net",
        tailnetNodeId: "n-idle-peer",
        origin: PEER_ORIGIN,
        online: true,
      }] : [],
    }),
  }));
  if (includePeer) {
    await page.route(`${PEER_ORIGIN}/api/machine`, (route) => route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-idle-peer",
          installationId: PEER_INSTALLATION_ID,
          displayName: "verified idle peer",
          origin: PEER_ORIGIN,
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    }));
  }
  await page.route("**/api/sessions", (route) => {
    requestCount += 1;
    const sessions = new URL(route.request().url()).origin === PEER_ORIGIN
      ? peerSessions
      : localSessions;
    return route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions }),
    });
  });

  return {
    setLocalSessions(sessions) { localSessions = sessions; },
    sessionRequestCount() { return requestCount; },
  };
}

function visibleDashboard(page: Page) {
  return page.locator([
    "#session-list:not([hidden])",
    "body:has(#session-list[hidden]) #sidebar-session-list",
  ].join(", "));
}

function visibleSessionCards(page: Page) {
  return visibleDashboard(page).locator(".card");
}

function visibleSessionCardNames(page: Page): Promise<string[]> {
  return visibleSessionCards(page).locator(".card-name-text").allTextContents();
}

function visibleViewButton(page: Page, view: "all" | "idle" | "attention") {
  return page.locator(`[data-action="set-session-card-view"][data-session-card-view="${view}"]`).filter({ visible: true });
}

async function selectIdleView(page: Page): Promise<void> {
  await visibleViewButton(page, "idle").press("Enter");
}

async function dispatchVisibleRefresh(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("attention distinguishes required action from updates and preserves placement", async ({ page }) => {
  const parent = { id: "parent-id", name: "parent" };
  const needing = session("need", manifestRuntimeState("needs-input"));
  const fixture = await installSessionFixture(page, {
    localSessions: [
      needing,
      session("failed", manifestRuntimeState("failed", true)),
      session("updated", manifestRuntimeState("done", true)),
      session(parent.name, manifestRuntimeState("working")),
      session("child", manifestRuntimeState("needs-input"), { parent }),
      session("stale", { ...manifestRuntimeState("needs-input"), freshness: "stale", stale: true }),
      session("quiet", fallbackRuntimeState("idle")),
    ],
  });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(server.baseUrl);
  const focus = visibleViewButton(page, "attention");
  await expect(focus).toHaveAccessibleName("Attention sessions: 2 need input, 1 failed, 1 updated since review");
  await expect(focus.locator(".session-attention-count")).toHaveText("3");
  await expect(focus.locator(".session-update-dot")).toBeVisible();
  await focus.press("Enter");
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["need", "failed", "updated", "child"]);
  await expect(visibleSessionCards(page).locator(".delegation-parent-missing")).toHaveCount(0);
  await expect(visibleViewButton(page, "attention")).toHaveAttribute("aria-pressed", "true");

  fixture.setLocalSessions([
    needing,
    session("failed", manifestRuntimeState("failed", true)),
    session("updated", manifestRuntimeState("done", true)),
    session(parent.name, manifestRuntimeState("working")),
    session("child", manifestRuntimeState("working"), { parent }),
    session("stale", { ...manifestRuntimeState("needs-input"), freshness: "stale", stale: true }),
    session("quiet", manifestRuntimeState("needs-input")),
  ]);
  await visibleViewButton(page, "attention").focus();
  await dispatchVisibleRefresh(page);
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["need", "failed", "updated", "quiet"]);
  await expect(visibleViewButton(page, "attention")).toBeFocused();
  expect(sockets).toEqual([]);
  await visibleViewButton(page, "all").click();
  await page.getByRole("button", { name: "Expand 1 child agent", exact: true }).filter({ visible: true }).click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["need", "failed", "updated", "parent", "child", "stale", "quiet"]);
});

test("attention counts and details retain verified peer scope for duplicate session names", async ({ page }) => {
  await installSessionFixture(page, {
    localSessions: [session("shared", manifestRuntimeState("done", true))],
    peerSessions: [
      session("shared", manifestRuntimeState("needs-input")),
      session("peer-stale", { ...manifestRuntimeState("failed"), stale: true, freshness: "stale" }),
    ],
  });
  await page.goto(server.baseUrl);
  const peer = visibleDashboard(page).locator(`.machine-group[data-machine="${PEER_IDENTITY}"]`);
  await expect(peer).toBeVisible();
  await expect(visibleViewButton(page, "attention")).toHaveAccessibleName("Attention sessions: 1 need input, 0 failed, 1 updated since review");
  await visibleViewButton(page, "attention").click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["shared", "shared"]);
  await peer.getByRole("button", { name: "Status details: shared", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Status: shared", exact: true });
  await expect(dialog).toContainText("Runtime: needs input");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const local = visibleDashboard(page).locator('.machine-group[data-machine=""]');
  await local.getByRole("button", { name: "Status details: shared", exact: true }).click();
  await expect(dialog).toContainText("Runtime: done");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("attention exposes urgent children without changing the normal collapsed view", async ({ page }) => {
  const parent = { id: "parent-id", name: "parent" };
  await installSessionFixture(page, { localSessions: [
    session(parent.name, manifestRuntimeState("needs-input")),
    session("child", manifestRuntimeState("failed"), { parent }),
  ] });
  await page.goto(server.baseUrl);
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["parent"]);
  await visibleViewButton(page, "attention").click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["parent", "child"]);
  await visibleViewButton(page, "all").click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["parent"]);
});

test("primary session action remains clickable alongside status details", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("wp-draft||test-project", "retain this draft"));
  await installSessionFixture(page, { localSessions: [session("test-project", manifestRuntimeState("needs-input"))] });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect.poll(() => sockets.length).toBe(1);
  await expect(page.getByRole("dialog", { name: "Status: test-project", exact: true })).not.toBeVisible();
  if (testInfo.project.name === "desktop") {
    const canvasLocator = page.locator("#terminal-view canvas").first();
    await expect(canvasLocator).toBeVisible();
    const canvas = await canvasLocator.elementHandle();
    if (!canvas) throw new Error("terminal canvas was not mounted");
    await expect(page.locator("#msg-input")).toHaveValue("retain this draft");
    await visibleViewButton(page, "attention").click();
    await expect(page.locator("#msg-input")).toHaveValue("retain this draft");
    expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
    await visibleViewButton(page, "all").click();
    expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
    expect(sockets).toHaveLength(1);
  }
});

test("status details are read-only, disclose provenance, and retain keyboard focus", async ({ page }) => {
  await installSessionFixture(page, { localSessions: [session("need", manifestRuntimeState("needs-input"))] });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(server.baseUrl);
  const details = page.getByRole("button", { name: "Status details: need", exact: true }).filter({ visible: true });
  await details.focus();
  await details.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Status: need", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Operator decision required <not HTML>");
  await expect(dialog).toContainText("local manifest (agent-reported, not verification)");
  await expect(dialog).toContainText("Freshness: fresh");
  await expect(dialog).toContainText("2026-10-01T12:00:00.000Z");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toBeFocused();
  expect(sockets).toEqual([]);
});

test("status snapshot survives refresh and returns focus to the exact session", async ({ page }) => {
  const fixture = await installSessionFixture(page, { localSessions: [session("need", manifestRuntimeState("needs-input"))] });
  await page.goto(server.baseUrl);
  const details = page.getByRole("button", { name: "Status details: need", exact: true }).filter({ visible: true });
  await details.focus();
  await details.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Status: need", exact: true });
  await expect(dialog).toBeVisible();
  fixture.setLocalSessions([session("need", { ...manifestRuntimeState("working"), message: "Newer report" })]);
  const before = fixture.sessionRequestCount();
  await dispatchVisibleRefresh(page);
  await expect.poll(() => fixture.sessionRequestCount()).toBeGreaterThan(before);
  await expect(visibleDashboard(page).locator(".triage-badge")).toHaveText("working");
  await expect(dialog).toContainText("Operator decision required <not HTML>");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toBeFocused();
});

test("status focus does not transfer to a replacement with the same session name", async ({ page }) => {
  const fixture = await installSessionFixture(page, { localSessions: [session("need", manifestRuntimeState("needs-input"))] });
  await page.goto(server.baseUrl);
  const details = page.getByRole("button", { name: "Status details: need", exact: true }).filter({ visible: true });
  await details.focus();
  await details.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Status: need", exact: true });
  await expect(dialog).toBeVisible();
  const replacement = session("need", manifestRuntimeState("failed"));
  fixture.setLocalSessions([{ ...replacement, identity: { ...replacement.identity, wolfpackSessionId: "replacement-id" } }]);
  await dispatchVisibleRefresh(page);
  await expect(details).toHaveAttribute("data-session-id", "replacement-id");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).not.toBeFocused();
});

test("attention zero state does not claim idle or task success", async ({ page }) => {
  await installSessionFixture(page, { localSessions: [session("quiet", fallbackRuntimeState("idle"))] });
  await page.goto(server.baseUrl);
  await visibleViewButton(page, "attention").click();
  await expect(visibleDashboard(page).getByRole("heading", { name: "No attention items" })).toBeVisible();
  await expect(visibleSessionCards(page)).toHaveCount(0);
  await expect(visibleDashboard(page)).toContainText("Quiet does not mean complete.");
  await visibleViewButton(page, "all").click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["quiet"]);
});

test("session-card controls are accessible, synchronized, and reject invalid views", async ({ page }, testInfo) => {
  await installSessionFixture(page, {
    localSessions: [session("quiet", fallbackRuntimeState("idle"))],
  });
  await page.goto(server.baseUrl);

  const idle = visibleViewButton(page, "idle");
  const all = visibleViewButton(page, "all");
  await expect(idle).toHaveAccessibleName("Idle sessions");
  await expect(all).toHaveAccessibleName("All sessions");
  await expect(idle).toHaveAttribute("aria-pressed", "false");
  await idle.focus();
  await expect(idle).toBeFocused();
  const idleControlStyle = await idle.evaluate((button) => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return { height: rect.height, outlineWidth: style.outlineWidth };
  });
  expect(idleControlStyle.height).toBeGreaterThanOrEqual(40);
  expect(idleControlStyle.outlineWidth).not.toBe("0px");

  await page.evaluate(() => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "set-session-card-view";
    button.dataset.sessionCardView = "invalid";
    document.body.append(button);
    button.click();
    button.remove();
  });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await selectIdleView(page);
  await expect(idle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-session-card-view][aria-pressed="true"]').filter({ visible: true })).toHaveCount(1);
  if (testInfo.project.name === "desktop") {
    await page.locator("#sidebar-expand-btn").click();
    await expect(visibleViewButton(page, "idle")).toHaveAttribute("aria-pressed", "true");
  }
});

test("idle uses exact runtime state across local and verified peers and updates live", async ({ page }) => {
  const parent = { id: "working-parent-id", name: "working-parent" };
  const fixture = await installSessionFixture(page, {
    localSessions: [
      session("quiet-local", fallbackRuntimeState("idle")),
      session("structured-needs-input", manifestRuntimeState("needs-input")),
      session("structured-done", manifestRuntimeState("done")),
      session("structured-failed", manifestRuntimeState("failed")),
      session(parent.name, manifestRuntimeState("working"), { triage: "idle" }),
      session("idle-child", manifestRuntimeState("idle"), { parent }),
    ],
    peerSessions: [
      session("quiet-peer", fallbackRuntimeState("idle")),
      session("peer-working", manifestRuntimeState("working"), { triage: "idle" }),
    ],
  });
  await page.goto(server.baseUrl);
  await expect(visibleDashboard(page).locator(`.machine-group[data-machine="${PEER_IDENTITY}"]`)).toBeVisible();

  await selectIdleView(page);
  await expect.poll(() => visibleSessionCardNames(page)).toEqual([
    "quiet-local",
    "idle-child",
    "quiet-peer",
  ]);
  await expect(visibleSessionCards(page).locator(".delegation-parent-missing")).toHaveCount(0);

  fixture.setLocalSessions([
    session("quiet-local", manifestRuntimeState("working"), { triage: "idle" }),
    session("structured-needs-input", manifestRuntimeState("idle")),
    session("structured-done", manifestRuntimeState("done")),
    session("structured-failed", manifestRuntimeState("failed")),
    session(parent.name, manifestRuntimeState("working"), { triage: "idle" }),
    session("idle-child", manifestRuntimeState("idle"), { parent }),
  ]);
  const requestsBeforeRefresh = fixture.sessionRequestCount();
  await dispatchVisibleRefresh(page);
  await expect.poll(() => fixture.sessionRequestCount()).toBeGreaterThan(requestsBeforeRefresh);
  await expect.poll(() => visibleSessionCardNames(page)).toEqual([
    "structured-needs-input",
    "idle-child",
    "quiet-peer",
  ]);
});

test("idle true-zero uses idle copy and All restores onboarding", async ({ page }) => {
  await installSessionFixture(page, { localSessions: [], peerSessions: [] });
  await page.goto(server.baseUrl);
  await expect(visibleDashboard(page).locator(`.machine-group[data-machine="${PEER_IDENTITY}"]`)).toBeVisible();

  await selectIdleView(page);
  await expect(visibleDashboard(page).getByRole("heading", { name: "No sessions are currently idle" })).toHaveCount(2);
  await expect(visibleDashboard(page).getByRole("button", { name: "Create your first session" })).toHaveCount(0);

  await visibleViewButton(page, "all").click();
  await expect(visibleDashboard(page).getByRole("heading", { name: "No sessions yet" })).toHaveCount(2);
  await expect(visibleDashboard(page).getByRole("button", { name: "Create your first session" })).toHaveCount(2);
});

test("desktop Cmd navigation does not leave an empty Idle view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard interaction");
  await installSessionFixture(page, {
    localSessions: [session("working", manifestRuntimeState("working"), { triage: "idle" })],
  });
  await page.goto(server.baseUrl);
  await selectIdleView(page);

  await expect(visibleDashboard(page).getByRole("heading", { name: "No sessions are currently idle" })).toBeVisible();
  await page.keyboard.press("Meta+ArrowDown");
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
  await expect(page.locator('#sidebar-session-list [data-action="open-session"][aria-current="page"]')).toHaveCount(0);
});

test("desktop idle reorder stays inside visible cards", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard interaction");
  await installSessionFixture(page, {
    localSessions: [
      session("idle-a", fallbackRuntimeState("idle")),
      session("working-b", manifestRuntimeState("working"), { triage: "idle" }),
      session("idle-c", fallbackRuntimeState("idle")),
    ],
  });
  await page.goto(server.baseUrl);
  const list = page.locator("#sidebar-session-list");
  await selectIdleView(page);
  await expect(list.locator('.card[data-session-order-id="working-b-id"]')).toHaveCount(0);

  const idleA = list.locator('.card[data-session-order-id="idle-a-id"] .card-open');
  await idleA.focus();
  await page.keyboard.press("Alt+ArrowDown");
  const replacementIdleA = list.locator('.card[data-session-order-id="idle-a-id"] .card-open');
  await expect(replacementIdleA).toBeFocused();
  expect(await visibleSessionCardNames(page)).toEqual(["idle-c", "idle-a"]);
  await expect(page.locator("#session-order-status")).toHaveText("idle-a moved to position 2");

  await visibleViewButton(page, "all").click();
  await expect.poll(() => visibleSessionCardNames(page)).toEqual(["working-b", "idle-c", "idle-a"]);
});
