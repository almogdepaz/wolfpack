/**
 * Reconnect visual feedback — simulate WS disconnect, verify reconnecting
 * UI state (orange banner), verify recovery (banner hidden).
 *
 * Mobile-only: tests the /ws/terminal capture-pane polling path.
 *
 * Strategy: Use page.routeWebSocket() to intercept the WS connection,
 * proxy it to the real server, then close the page-facing side to simulate
 * a server disconnect. The client sees onclose → shows "reconnecting…"
 * banner → retries → new WS connects → banner hides.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

/** Helper: set up a WS proxy that exposes the page-facing route for later close(). */
function setupWsProxy(page: import("@playwright/test").Page) {
  // Tracks the FIRST (active) page-facing route for disconnect simulation.
  // routeWebSocket fires for each new WS connection (including reconnects),
  // so this gets overwritten on each reconnect — which is fine.
  let activeRoute: WebSocketRoute | null = null;
  let connectionCount = 0;

  const ready = page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    const server = ws.connectToServer();
    connectionCount++;

    // Proxy messages bidirectionally
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((msg) => ws.send(msg));

    // Forward close from either side (disables default auto-forwarding)
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));

    activeRoute = ws;
  });

  return {
    ready,
    /** Close the page-facing WS to simulate a server disconnect */
    disconnect: () => {
      if (!activeRoute) throw new Error("no active WS route to disconnect");
      activeRoute.close({ code: 1006, reason: "simulated disconnect" });
    },
    get connectionCount() {
      return connectionCount;
    },
  };
}

test("WS disconnect shows reconnecting banner then recovers", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop",
    "mobile-only /ws/terminal flow",
  );

  const proxy = setupWsProxy(page);
  await proxy.ready;

  // ── Navigate & open a session ──
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: "test-project" }).first().click();

  // Verify terminal output arrives (WS is live)
  const terminal = page.locator("#terminal");
  await expect(terminal).toContainText("mock-terminal-ready", {
    timeout: 5000,
  });

  // Verify conn-status is hidden (live state)
  const connStatus = page.locator("#conn-status");
  await expect(connStatus).toBeHidden();

  // ── Simulate server-side disconnect ──
  proxy.disconnect();

  // ── Verify reconnecting banner appears (orange, "reconnecting…") ──
  await expect(connStatus).toBeVisible({ timeout: 3000 });
  await expect(connStatus).toContainText(/reconnecting/i, { timeout: 3000 });

  // ── Verify auto-recovery: banner disappears once reconnected ──
  // Client backoff starts at 500ms, so first retry hits within ~1s.
  // Once new WS connects and receives output, setConnState("live") hides banner.
  await expect(connStatus).toBeHidden({ timeout: 10000 });

  // Verify terminal still shows output after reconnect
  await expect(terminal).toContainText("mock-terminal-ready", {
    timeout: 5000,
  });
});

test("WS disconnect during active session preserves terminal content", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop",
    "mobile-only /ws/terminal flow",
  );

  const proxy = setupWsProxy(page);
  await proxy.ready;

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: "test-project" }).first().click();

  const terminal = page.locator("#terminal");
  await expect(terminal).toContainText("mock-terminal-ready", {
    timeout: 5000,
  });

  // Send a command before disconnect
  await page.locator("#msg-input").fill("echo test-data");
  await page.locator("#send-btn").click();
  await expect(terminal).toContainText("command-output", { timeout: 5000 });

  // Disconnect
  proxy.disconnect();

  // Wait for reconnecting state
  const connStatus = page.locator("#conn-status");
  await expect(connStatus).toBeVisible({ timeout: 3000 });

  // Terminal content should still be visible during reconnect
  await expect(terminal).toContainText("command-output");

  // Wait for recovery
  await expect(connStatus).toBeHidden({ timeout: 10000 });
});
