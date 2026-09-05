import { expect, test, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

const observedAt = new Date().toISOString();
const PEER_ORIGIN = "https://activity-peer.example.ts.net";
const PEER_INSTALLATION_ID = "6b0c31a8-f99e-4c17-b681-881c40381ef2";

const sessions = [
  {
    name: "unproven",
    lastLine: "plain terminal prompt",
    triage: "idle",
    identity: { wolfpackSessionId: "id-unproven" },
    runtimeState: { state: "needs-input", unseen: true, transitionSequence: 4 },
    activity: { freshness: "unknown", observedAt, display: "activity unavailable" },
  },
  {
    name: "structured",
    lastLine: "structured input request",
    triage: "idle",
    identity: { wolfpackSessionId: "id-structured" },
    runtimeState: {
      state: "needs-input",
      authority: "manifest",
      freshness: "fresh",
      source: "local-manifest",
      stale: false,
      unseen: true,
      transitionSequence: 7,
    },
    activity: { freshness: "fresh", observedAt, quietSince: observedAt, display: "" },
  },
  {
    name: "active-output",
    lastLine: "new bytes",
    triage: "running",
    identity: { wolfpackSessionId: "id-output" },
    runtimeState: {
      state: "output",
      authority: "fallback",
      freshness: "fresh",
      source: "screen-fallback",
      stale: false,
      unseen: true,
      transitionSequence: 3,
    },
    activity: { freshness: "fresh", observedAt, lastRenderedActivityAt: observedAt, display: "" },
  },
];

const malformedPeerSession = {
  name: "malformed-activity",
  lastLine: "untrusted peer payload",
  triage: "idle",
  identity: { wolfpackSessionId: "id-malformed" },
  runtimeState: { state: "idle", unseen: true, transitionSequence: 1 },
  activity: {
    freshness: "fresh",
    observedAt: "not-a-timestamp",
    lastRenderedActivityAt: "not-a-timestamp",
    quietSince: "not-a-timestamp",
    display: "active now",
  },
};

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions }),
  }));
});

test("removes attention controls and unseen decoration", async ({ page }) => {
  await page.goto(server.baseUrl);

  await expect(page.locator("#sessions-attention-toolbar")).toHaveCount(0);
  await expect(page.locator(".attention-session, .unseen-marker, .attention-clear-btn")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /attention|clear unseen/i })).toHaveCount(0);
});

test("shows semantic labels only for source-backed runtime state", async ({ page }) => {
  await page.goto(server.baseUrl);

  const cardBadge = (name: string) => page
    .getByRole("button", { name: `Open ${name}` })
    .locator("xpath=..")
    .locator(".triage-badge");

  await expect(cardBadge("unproven")).toHaveText("quiet");
  await expect(cardBadge("structured")).toHaveText("needs input");
  await expect(cardBadge("active-output")).toHaveText("output");
});

test("shows rendered activity context and review changes without altering semantic status", async ({ page }) => {
  await page.goto(server.baseUrl);

  const card = (name: string) => page.getByRole("button", { name: `Open ${name}` }).locator("xpath=..");
  await expect(card("active-output").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("structured").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("unproven").locator(".session-activity")).toHaveText("activity unavailable · changed since review");
});

test("omits activity from remote session responses", async ({ page }) => {
  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{
        hostname: "activity-peer.example.ts.net",
        tailnetNodeId: "n-activity-peer",
        origin: PEER_ORIGIN,
        online: true,
      }],
    }),
  }));
  await page.route(`${PEER_ORIGIN}/api/machine`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-activity-peer",
        installationId: PEER_INSTALLATION_ID,
        displayName: "activity peer",
        origin: PEER_ORIGIN,
      },
      wolfpack: { version: "1.7.0" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route(`${PEER_ORIGIN}/api/sessions`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ sessions: [malformedPeerSession] }),
  }));

  await page.goto(server.baseUrl);

  const card = page.getByRole("button", { name: "Open malformed-activity" }).locator("xpath=..");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");
});

test("opening a terminal acknowledges its observed transition once after websocket open", async ({ page }) => {
  const newerSessions = sessions.map((session) => session.name === "structured"
    ? {
      ...session,
      triage: "running",
      runtimeState: {
        ...session.runtimeState,
        state: "output",
        unseen: true,
        transitionSequence: 8,
      },
    }
    : session);
  let sessionRequests = 0;
  let refreshResponseSent: (() => void) | undefined;
  const refreshResponse = new Promise<void>((resolve) => { refreshResponseSent = resolve; });
  await page.unroute("**/api/sessions");
  await page.route("**/api/sessions", (route) => {
    sessionRequests += 1;
    const refreshed = sessionRequests > 1;
    if (refreshed) refreshResponseSent?.();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: refreshed ? newerSessions : sessions }),
    });
  });

  const acknowledgements: unknown[] = [];
  const sockets: WebSocketRoute[] = [];
  let attachCount = 0;
  let allowFirstOpen: (() => void) | undefined;
  const firstOpenAllowed = new Promise<void>((resolve) => { allowFirstOpen = resolve; });
  let firstSocketCaptured: (() => void) | undefined;
  const firstSocket = new Promise<void>((resolve) => { firstSocketCaptured = resolve; });
  let acknowledgeResponseSent: (() => void) | undefined;
  const acknowledgeResponse = new Promise<void>((resolve) => { acknowledgeResponseSent = resolve; });
  let acknowledgementRequested: (() => void) | undefined;
  const acknowledgementRequest = new Promise<void>((resolve) => { acknowledgementRequested = resolve; });
  const hydrate = (socket: WebSocketRoute): void => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type !== "attach") return;
      attachCount += 1;
      socket.send(JSON.stringify({ type: "attach_ack" }));
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  };
  await page.routeWebSocket(/\/ws\/pty/, async (socket) => {
    sockets.push(socket);
    if (sockets.length === 1) {
      firstSocketCaptured?.();
      await firstOpenAllowed;
    }
    hydrate(socket);
  });
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    acknowledgements.push(route.request().postDataJSON());
    acknowledgementRequested?.();
    await acknowledgeResponse;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        runtimeState: {
          state: "needs-input",
          authority: "manifest",
          freshness: "fresh",
          source: "local-manifest",
          stale: false,
          unseen: false,
          transitionSequence: 7,
        },
      }),
    });
  });
  await page.goto(server.baseUrl);

  const card = page.getByRole("button", { name: "Open structured" }).locator("xpath=..");
  expect(acknowledgements).toEqual([]);
  await card.click();
  await firstSocket;
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  expect(acknowledgements).toEqual([]);

  allowFirstOpen?.();
  await expect.poll(() => attachCount).toBe(1);
  await acknowledgementRequest;
  await expect.poll(() => acknowledgements).toEqual([{ sessionId: "id-structured", transitionSequence: 7 }]);

  if (test.info().project.name === "iphone-se") {
    await page.getByRole("button", { name: "← Back" }).click();
  } else {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  await refreshResponse;
  await expect(card.locator(".triage-badge")).toHaveText("output");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");

  acknowledgeResponseSent?.();
  await expect(card.locator(".triage-badge")).toHaveText("output");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");

  if (test.info().project.name !== "iphone-se") {
    sockets[0]?.close({ code: 1006, reason: "test reconnect" });
    await expect.poll(() => sockets.length).toBe(2);
    await expect.poll(() => acknowledgements).toEqual([{ sessionId: "id-structured", transitionSequence: 7 }]);
  }
});
