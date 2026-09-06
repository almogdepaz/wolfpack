import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

function visibleSessionList(page: Page) {
  return page.locator([
    "#session-list:not([hidden])",
    "body:has(#session-list[hidden]) #sidebar-session-list",
  ].join(", "));
}

// Peer enumeration reflects the test runner's real Tailnet unless isolated.
// These cadence tests exercise only local session refreshes.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [] }),
  }));
});

test("session summaries survive metadata endpoint failure", async ({ page }) => {
  await page.route("**/api/info", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "metadata unavailable" }) }));
  await page.goto(server.baseUrl);

  await expect(page.getByRole("button", { name: "Open test-project" })).toBeVisible();
});

test("session summaries do not wait for local metadata", async ({ page }) => {
  let releaseInfo: () => void = () => {};
  const infoReleased = new Promise<void>((resolve) => {
    releaseInfo = resolve;
  });
  await page.route("**/api/info", async (route) => {
    await infoReleased;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "delayed-local", version: "9.9.9" }),
    });
  });

  await page.goto(server.baseUrl);
  try {
    await expect(page.getByRole("button", { name: "Open test-project" })).toBeVisible({ timeout: 1_000 });
  } finally {
    releaseInfo();
  }
  await expect(page.locator("#session-list .machine-header")).toContainText("delayed-local");
});

test("local info metadata survives an unavailable Tailnet handshake", async ({ page }) => {
  await page.route("**/api/machine", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tailnet machine identity unavailable" }) }));
  await page.route("**/api/info", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "local-no-tailnet", version: "9.9.9" }) }));
  await page.goto(server.baseUrl);

  await expect(page.locator("#settings-version")).toHaveText("wolfpack v9.9.9");
  await expect(page.locator("#session-list .machine-header")).toContainText("local-no-tailnet");
});

for (const { localVersion, localOutdated, peerOutdated } of [
  { localVersion: "1.6.21", localOutdated: false, peerOutdated: false },
  { localVersion: "1.6.20", localOutdated: true, peerOutdated: false },
  { localVersion: "1.6.22", localOutdated: false, peerOutdated: true },
]) {
  test(`version warnings reflect delayed local metadata ${localVersion}`, async ({ page }) => {
    const peerOrigin = "https://version-peer.example.ts.net";
    const peerInstallationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
    let releaseInfo: () => void = () => {};
    const infoGate = new Promise<void>((resolve) => { releaseInfo = resolve; });
    // Isolate network metadata, not the production grouping/version UI.
    await page.route("**/api/info", async (route) => {
      await infoGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ name: "version-local", version: localVersion }),
      });
    });
    await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [{
        hostname: "version-peer.example.ts.net", tailnetNodeId: "n-version-peer", origin: peerOrigin, online: true,
      }] }),
    }));
    await page.route(`${peerOrigin}/api/machine`, (route) => route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-version-peer", installationId: peerInstallationId,
          displayName: "version-peer", origin: peerOrigin,
        },
        wolfpack: { version: "1.6.21" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    }));
    await page.route(`${peerOrigin}/api/sessions`, (route) => route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    }));

    await page.goto(server.baseUrl);
    const localGroup = page.locator('#session-list > .machine-group[data-machine=""]');
    const peerGroup = page.locator(`#session-list > .machine-group[data-machine="n-version-peer:${peerInstallationId}"]`);
    try {
      const expandSessions = page.getByRole("button", { name: "Expand sessions", exact: true });
      if (await expandSessions.isVisible()) await expandSessions.click();
      await expect(peerGroup).toBeVisible();
      // Missing local metadata must not be presented as an outdated version.
      await expect(localGroup.locator(".version-warning")).toHaveCount(0);
      releaseInfo();
      await expect(localGroup.locator(".machine-header")).toContainText("version-local");
      await expect(localGroup.locator(".version-warning")).toHaveCount(Number(localOutdated), { timeout: 1_000 });
      await expect(peerGroup.locator(".version-warning")).toHaveCount(Number(peerOutdated), { timeout: 1_000 });
      if (localOutdated) {
        await expect(localGroup.locator(".version-warning")).toHaveAttribute("title", `Running v${localVersion} — newer version available on another machine`);
      }
      if (peerOutdated) {
        await expect(peerGroup.locator(".version-warning")).toHaveAttribute("title", "Running v1.6.21 — newer version available on another machine");
      }
    } finally {
      releaseInfo();
    }
  });
}

test("concurrent forced refresh requests coalesce into one follow-up", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(visibleSessionList(page).locator(".card").first()).toBeVisible();

  let requestCount = 0;
  await page.route("**/api/sessions", async (route) => {
    requestCount++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requestCount).toBe(2);

  expect(requestCount).toBe(2);
});

test("machine metadata is cached across session refreshes", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(visibleSessionList(page).locator(".card").first()).toBeVisible();

  let infoRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/info") infoRequests++;
  });

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(5_500);

  expect(infoRequests).toBe(0);
});

test("visibility resume keeps one session refresh cadence", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(visibleSessionList(page).locator(".card").first()).toBeVisible();

  let sessionRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sessions") sessionRequests++;
  });

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(5_500);

  // The startup Tailnet generation coordinates one replacement; visibility
  // resume and the 5s cadence add at most two more local captures.
  expect(sessionRequests).toBeLessThanOrEqual(3);
});
