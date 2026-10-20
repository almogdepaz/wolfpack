import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

test("triage filters toggle off, preserve row actions, and capture responsive chrome", async ({ page }, info) => {
  test.skip(!["desktop", "iphone-14"].includes(info.project.name));
  const inputBytes: number[][] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    const upstream = socket.connectToServer();
    socket.onMessage(message => {
      if (typeof message !== "string") inputBytes.push(Array.from(Buffer.from(message)));
      upstream.send(message);
    });
    upstream.onMessage(message => socket.send(message));
  });
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  const peerOrigin = "https://reskin-peer.example.ts.net";
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "reskin-peer.example.ts.net", tailnetNodeId: "n-reskin", origin: peerOrigin, online: true }] } }));
  await page.route(`${peerOrigin}/api/machine`, route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-reskin", installationId: "f9ae7025-30ad-4461-bc57-365431dbf00c", displayName: "MacBook", origin: peerOrigin },
    wolfpack: { version: "1.6.26" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  } }));
  await page.route("**/api/sessions", async route => {
    if (new URL(route.request().url()).origin === peerOrigin) {
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { sessions: [{ name: "review-agent", lastLine: "Review complete. Tests passed.", identity: { wolfpackSessionId: "review-agent-id", agentKind: "pi" }, runtimeState: { state: "done", authority: "manifest", freshness: "fresh", source: "local-manifest", stale: false } }] } });
      return;
    }
    const response = await route.fetch();
    const data: { sessions: Array<{ name: string; identity?: Record<string, unknown> }> } = await response.json();
    data.sessions = data.sessions.map((session, index) => ({
      ...session,
      identity: { ...session.identity, agentKind: index % 2 ? "pi" : "claude" },
      runtimeState: { state: session.name === "test-project" ? "needs-input" : index % 2 ? "working" : "done", authority: "manifest", freshness: "fresh", source: "local-manifest", stale: false },
    }));
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list .card").first()).toBeVisible();
  await expect(page.locator("#session-list .machine-group:not(.needs-you)")).toHaveCount(2);
  await expect(page.locator("#session-list .needs-you")).toHaveCount(1);
  const tabs = page.locator("#dashboard-session-filter");
  await expect(tabs.getByRole("button")).toHaveCount(4);
  const original = await page.locator("#session-list .card").count();
  const idle = tabs.getByRole("button", { name: "Idle sessions", exact: true });
  await idle.click();
  await expect(idle).toHaveAttribute("aria-pressed", "true");
  await idle.click();
  await expect(idle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#session-list .card")).toHaveCount(original);
  if (info.project.name === "desktop") {
    await page.locator("#dashboard-search").fill("no-such-session");
    await expect(page.locator("#session-list .card:visible")).toHaveCount(0);
    await page.keyboard.press("Meta+ArrowDown");
    await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
    await page.locator("#dashboard-search").fill("");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({ path: info.outputPath(`dashboard-${width}.png`), animations: "disabled" });
  await expect(access(info.outputPath(`dashboard-${width}.png`))).resolves.toBeUndefined();
  await page.getByRole("button", { name: "Open test-project", exact: true }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await expect(page.locator("#needs-input-banner")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`terminal-${width}.png`), animations: "disabled" });
  for (const [key, expected] of [["y", 121], ["n", 110], ["Escape", 27]] as const) {
    inputBytes.length = 0;
    await page.locator(`[data-reply-key="${key}"]`).click();
    await expect.poll(() => inputBytes).toEqual([[expected]]);
  }
});
