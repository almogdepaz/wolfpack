import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
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
  let attachedSession = "";
  await page.routeWebSocket(/\/ws\/pty/, (socket) => {
    attachedSession = new URL(socket.url()).searchParams.get("session") || "";
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

  await expect.poll(() => attachedSession).toBe("current-agent-name");
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect.poll(async () => {
    const activeCard = page.locator('[data-action="open-session"][aria-current="page"]').first();
    if (await activeCard.count() > 0) return await activeCard.getAttribute("data-session");
    const chipLabel = page.locator("#chip-label");
    if (await chipLabel.count() > 0) return (await chipLabel.textContent())?.trim();
    return "";
  }).toBe("current-agent-name");
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5_000 });
});
