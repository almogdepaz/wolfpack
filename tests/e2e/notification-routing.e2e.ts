import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("notification session route resolves stable identity in its machine context", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{
          name: "current-agent-name",
          lastLine: "",
          triage: "idle",
          runtimeState: { state: "idle", unseen: false },
          identity: {
            wolfpackSessionId: "stable-session-id",
            wolfpackSessionName: "current-agent-name",
          },
        }],
      }),
    });
  });
  await page.routeWebSocket(/\/ws\/pty/, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack" }));
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(`${server.baseUrl}/?sessionId=stable-session-id&session=stale-name&machine=local`);

  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as { state?: { currentSession?: string; currentMachine?: string } }).state;
    return { session: state?.currentSession, machine: state?.currentMachine };
  })).toEqual({ session: "current-agent-name", machine: "" });
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5_000 });
});
