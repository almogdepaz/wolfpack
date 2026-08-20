import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
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

test("local info metadata survives an unavailable Tailnet handshake", async ({ page }) => {
  await page.route("**/api/machine", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tailnet machine identity unavailable" }) }));
  await page.route("**/api/info", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "local-no-tailnet", version: "9.9.9" }) }));
  await page.goto(server.baseUrl);

  await expect(page.locator("#settings-version")).toHaveText("wolfpack v9.9.9");
  await expect(page.locator("#session-list .machine-header")).toContainText("local-no-tailnet");
});

test("concurrent refresh requests share one in-flight capture", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(visibleSessionList(page).locator(".card").first()).toBeVisible();

  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestCount = 0;
  await page.route("**/api/sessions", async (route) => {
    requestCount++;
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
    activeRequests--;
  });

  await page.evaluate(async () => {
    const refresh = (window as typeof window & { loadSessions: () => Promise<void> }).loadSessions;
    await Promise.all([refresh(), refresh(), refresh()]);
  });

  expect(requestCount).toBe(1);
  expect(maxActiveRequests).toBe(1);
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
