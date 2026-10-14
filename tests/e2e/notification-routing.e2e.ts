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

test("notification session route opens a peer session through the home origin", async ({ page }) => {
  const origin = "https://peer.example.ts.net";
  const installationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const identity = `n-peer:${installationId}`;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [{ hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin, online: true }] }) }));
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/machine"
      ? { protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-peer", installationId, displayName: "peer", origin }, wolfpack: { version: "1.0.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"] }
      : path === "/api/sessions"
        ? { sessions: [{ name: "renamed-peer-agent", lastLine: "", triage: "idle", runtimeState: { state: "idle", unseen: false }, identity: { wolfpackSessionId: "peer-stable-id", wolfpackSessionName: "renamed-peer-agent" } }] }
        : {};
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  let attachedUrl = "";
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    attachedUrl = socket.url();
    socket.onMessage(message => {
      if (typeof message !== "string" || JSON.parse(message).type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack" }));
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.goto(`${server.baseUrl}/?${new URLSearchParams({ sessionId: "peer-stable-id", session: "old-name", machine: identity })}`);
  await expect.poll(() => attachedUrl && new URL(attachedUrl).searchParams.get("session")).toBe("renamed-peer-agent");
  expect(new URL(attachedUrl).origin).toBe("wss://peer.example.ts.net");
  await expect(page).toHaveURL(server.baseUrl + "/");
  await expect(page.locator("#terminal-view")).toBeVisible();
});
