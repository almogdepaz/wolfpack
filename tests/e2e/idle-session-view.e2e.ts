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

function manifestRuntimeState(state: "working" | "needs-input" | "done" | "failed" | "idle") {
  return {
    state,
    authority: "manifest",
    freshness: "fresh",
    source: "local-manifest",
    stale: false,
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

function visibleViewButton(page: Page, view: "all" | "idle") {
  return page.locator(`[data-action="set-session-card-view"][data-session-card-view="${view}"]`).filter({ visible: true });
}

async function selectIdleView(page: Page): Promise<void> {
  await visibleViewButton(page, "idle").press("Enter");
}

async function dispatchVisibleRefresh(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

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
