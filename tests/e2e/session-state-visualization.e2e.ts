import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

declare global {
  interface Window {
    __quietAlertHaptics?: unknown[];
  }
}

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
    activity: { freshness: "fresh", observedAt, lastRenderedActivityAt: observedAt, display: "active 2m" },
  },
  {
    name: "unobserved",
    lastLine: "no activity observation",
    triage: "idle",
    identity: { wolfpackSessionId: "id-unobserved" },
    runtimeState: { state: "idle", unseen: true, transitionSequence: 6 },
    activity: { freshness: "unknown", observedAt, display: "activity unobserved" },
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

async function gateFirstTerminalWebsocketOpen(page: Page) {
  const sockets: WebSocketRoute[] = [];
  let attachCount = 0;
  let allowFirstOpen: (() => void) | undefined;
  const firstOpenAllowed = new Promise<void>((resolve) => { allowFirstOpen = resolve; });
  let firstSocketCaptured: (() => void) | undefined;
  const firstSocket = new Promise<void>((resolve) => { firstSocketCaptured = resolve; });
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
  return {
    sockets,
    firstSocket,
    allowFirstOpen: () => allowFirstOpen?.(),
    attachCount: () => attachCount,
  };
}

test("preserves session baseline through no-fact activity and haptics each new local quiet episode", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ notifications: true, haptics: true }));
    const samples: unknown[] = [];
    const registration = {
      pushManager: {
        subscribe: async () => ({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "key", auth: "auth" } }) }),
      },
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => registration, ready: Promise.resolve(registration) },
    });
    Object.defineProperty(window, "__quietAlertHaptics", { configurable: true, value: samples });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: unknown) => {
        samples.push(pattern);
        return true;
      },
    });
  });
  await page.route("**/api/push/vapid-key", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ publicKey: "AQ" }),
  }));
  await page.route("**/api/push/subscribe", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.unroute("**/api/sessions");
  let sessionRequests = 0;
  let releaseSecondResponse: (() => void) | undefined;
  const secondResponseReleased = new Promise<void>((resolve) => { releaseSecondResponse = resolve; });
  let secondRequestStarted: (() => void) | undefined;
  const secondRequest = new Promise<void>((resolve) => { secondRequestStarted = resolve; });
  let releaseThirdResponse: (() => void) | undefined;
  const thirdResponseReleased = new Promise<void>((resolve) => { releaseThirdResponse = resolve; });
  let thirdRequestStarted: (() => void) | undefined;
  const thirdRequest = new Promise<void>((resolve) => { thirdRequestStarted = resolve; });
  const session = (name: string, sessionId: string, episodeId?: string) => ({
    name,
    lastLine: "quiet terminal",
    triage: "idle",
    identity: { wolfpackSessionId: sessionId },
    runtimeState: { state: "idle", unseen: false, transitionSequence: 1 },
    ...(episodeId && {
      quietAlert: {
        kind: "quiet",
        sessionId,
        episodeId,
        eligibleAtMs: Date.now() - 1,
        observedAtMs: Date.now(),
      },
    }),
  });
  const sessionsFor = (phase: number) => phase === 1
    ? [
      session("new-episode-initial", "new-episode-id"),
      session("historical-baseline", "historical-id", "historical-episode-one"),
    ]
    : phase === 2
      ? [
        session("new-episode-activity", "new-episode-id"),
        session("historical-activity", "historical-id"),
      ]
      : [
        session("new-episode-quiet", "new-episode-id", "new-episode-one"),
        session("historical-quiet", "historical-id", "historical-episode-two"),
      ];
  await page.route("**/api/sessions", async (route) => {
    sessionRequests += 1;
    if (sessionRequests === 2) {
      secondRequestStarted?.();
      await secondResponseReleased;
    }
    if (sessionRequests === 3) {
      thirdRequestStarted?.();
      await thirdResponseReleased;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: sessionsFor(sessionRequests) }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open historical-baseline" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wp-effects") ?? "{}").notifications)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__quietAlertHaptics!)).toEqual([]);

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await secondRequest;
  releaseSecondResponse?.();
  await expect(page.getByRole("button", { name: "Open historical-activity" })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await thirdRequest;
  releaseThirdResponse?.();
  await expect(page.getByRole("button", { name: "Open historical-quiet" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__quietAlertHaptics!)).toEqual([
    [200, 100, 200],
    [200, 100, 200],
  ]);
});

test("haptics only fresh episodes and fails closed for stale or malformed facts from a ready verified peer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ notifications: true, haptics: true }));
    const samples: unknown[] = [];
    const registration = {
      pushManager: {
        subscribe: async () => ({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "key", auth: "auth" } }) }),
      },
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => registration, ready: Promise.resolve(registration) },
    });
    Object.defineProperty(window, "__quietAlertHaptics", { configurable: true, value: samples });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: unknown) => {
        samples.push(pattern);
        return true;
      },
    });
  });
  await page.route("**/api/push/vapid-key", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ publicKey: "AQ" }),
  }));
  await page.route("**/api/push/subscribe", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{ hostname: "activity-peer.example.ts.net", tailnetNodeId: "n-activity-peer", origin: PEER_ORIGIN, online: true }],
    }),
  }));
  await page.route(`${PEER_ORIGIN}/api/machine`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: { tailnetNodeId: "n-activity-peer", installationId: PEER_INSTALLATION_ID, displayName: "activity peer", origin: PEER_ORIGIN },
      wolfpack: { version: "1.7.0" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  let remoteRequests = 0;
  let releaseSecondResponse: (() => void) | undefined;
  const secondResponseReleased = new Promise<void>((resolve) => { releaseSecondResponse = resolve; });
  let secondRequestStarted: (() => void) | undefined;
  const secondRequest = new Promise<void>((resolve) => { secondRequestStarted = resolve; });
  let releaseThirdResponse: (() => void) | undefined;
  const thirdResponseReleased = new Promise<void>((resolve) => { releaseThirdResponse = resolve; });
  let thirdRequestStarted: (() => void) | undefined;
  const thirdRequest = new Promise<void>((resolve) => { thirdRequestStarted = resolve; });
  const remoteSessions = (request: number) => {
    const stale = request >= 3;
    const observedAtMs = stale ? Date.now() - 15_001 : Date.now();
    const name = request === 1 ? "remote-stale" : request === 2 ? "remote-verified-new" : "remote-stale-after-refresh";
    const episodeId = request === 1 ? "remote-episode-one" : request === 2 ? "remote-episode-two" : "remote-episode-three";
    return [
      {
        name,
        lastLine: "remote terminal",
        triage: "idle",
        identity: { wolfpackSessionId: "remote-stale-id" },
        runtimeState: { state: "idle", unseen: false, transitionSequence: request },
        quietAlert: {
          kind: "quiet",
          sessionId: "remote-stale-id",
          episodeId,
          eligibleAtMs: observedAtMs - 1,
          observedAtMs,
        },
      },
      {
        name: "remote-malformed",
        lastLine: "remote terminal",
        triage: "idle",
        identity: { wolfpackSessionId: "remote-malformed-id" },
        runtimeState: { state: "idle", unseen: false, transitionSequence: request },
        quietAlert: {
          kind: "quiet",
          sessionId: "remote-malformed-id",
          episodeId: "remote-malformed-episode",
          eligibleAtMs: 1,
          observedAtMs: "not-a-timestamp",
        },
      },
    ];
  };
  await page.route(`${PEER_ORIGIN}/api/sessions`, async (route) => {
    remoteRequests += 1;
    if (remoteRequests === 2) {
      secondRequestStarted?.();
      await secondResponseReleased;
    }
    if (remoteRequests === 3) {
      thirdRequestStarted?.();
      await thirdResponseReleased;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: remoteSessions(remoteRequests) }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open remote-stale" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wp-effects") ?? "{}").notifications)).toBe(true);
  // Tailnet discovery has already started the follow-up fetch. Do not force a
  // refresh here: that aborts this response and makes its result stale.
  await secondRequest;
  await page.evaluate(() => window.__quietAlertHaptics!.splice(0));
  releaseSecondResponse?.();
  await expect(page.getByRole("button", { name: "Open remote-verified-new" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__quietAlertHaptics!)).toEqual([[200, 100, 200]]);

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await thirdRequest;
  releaseThirdResponse?.();
  await expect(page.getByRole("button", { name: "Open remote-stale-after-refresh" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__quietAlertHaptics!)).toEqual([[200, 100, 200]]);
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

test("shows only review changes in session activity lines", async ({ page }) => {
  await page.goto(server.baseUrl);

  const card = (name: string) => page.getByRole("button", { name: `Open ${name}` }).locator("xpath=..");
  await expect(card("active-output").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("active-output").locator(".session-activity")).toHaveCSS("color", "rgb(102, 204, 255)");
  await expect(card("structured").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("unproven").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("unobserved").locator(".session-activity")).toHaveText("changed since review");
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

test("opening a terminal clears its acknowledged review change after websocket open", async ({ page }) => {
  const acknowledgements: unknown[] = [];
  const websocket = await gateFirstTerminalWebsocketOpen(page);
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    acknowledgements.push(route.request().postDataJSON());
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
  await expect(card.locator(".session-activity")).toHaveText("changed since review");
  expect(acknowledgements).toEqual([]);
  await card.click();
  await websocket.firstSocket;
  expect(acknowledgements).toEqual([]);

  websocket.allowFirstOpen();
  await expect.poll(() => websocket.attachCount()).toBe(1);
  await expect.poll(() => acknowledgements).toEqual([{ sessionId: "id-structured", transitionSequence: 7 }]);
  await expect(card.locator(".session-activity")).toHaveCount(0);

  if (!(await page.getByRole("button", { name: "← Back", exact: true }).isVisible())) {
    const sidebarCard = page.locator("#sidebar-session-list .card").filter({ hasText: "structured" });
    await expect(sidebarCard).toHaveCount(1);
    await expect(sidebarCard.locator(".session-activity")).toHaveCount(0);
  }
});

test("a delayed acknowledgement cannot clobber a newer runtime transition", async ({ page }) => {
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
  const websocket = await gateFirstTerminalWebsocketOpen(page);
  let acknowledgeResponseSent: (() => void) | undefined;
  const acknowledgeResponse = new Promise<void>((resolve) => { acknowledgeResponseSent = resolve; });
  let acknowledgementRequested: (() => void) | undefined;
  const acknowledgementRequest = new Promise<void>((resolve) => { acknowledgementRequested = resolve; });
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
  await websocket.firstSocket;
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  expect(acknowledgements).toEqual([]);

  websocket.allowFirstOpen();
  await expect.poll(() => websocket.attachCount()).toBe(1);
  await acknowledgementRequest;
  await expect.poll(() => acknowledgements).toEqual([{ sessionId: "id-structured", transitionSequence: 7 }]);

  const backButton = page.getByRole("button", { name: "← Back", exact: true });
  const mobileLayout = await backButton.isVisible();
  if (mobileLayout) {
    await backButton.click();
  } else {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  await refreshResponse;
  await expect(card.locator(".triage-badge")).toHaveText("output");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");

  acknowledgeResponseSent?.();
  await expect(card.locator(".triage-badge")).toHaveText("output");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");

  if (!mobileLayout) {
    websocket.sockets[0]?.close({ code: 1006, reason: "test reconnect" });
    await expect.poll(() => websocket.sockets.length).toBe(2);
    await expect.poll(() => acknowledgements).toEqual([{ sessionId: "id-structured", transitionSequence: 7 }]);
  }
});
