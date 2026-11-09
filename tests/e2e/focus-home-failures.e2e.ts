import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { remoteFocusHome } from "./focus-home-fixture";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "remote embedded-pane owner boundary"); });

for (const failure of ["identity", "not-owner"] as const) test(`C1: cached reload rejects ${failure} even while the old session projection is online`, async ({ page }, info) => {
  const home = await remoteFocusHome(page, server);
  try {
    await home.openHealthy();
    home.state.failure = failure;
    await page.reload();
    await home.ready();
    await expect.poll(home.rejected).toBeGreaterThan(0);
    await expect(page.locator("#assistant-setting-error")).toHaveText("focus home identity changed");
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await expect(page.locator("#assistant-content .focus-header")).toContainText("focus unavailable");
    await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
    await expect(page.locator("#assistant-pane-empty")).toBeVisible();
    expect(home.sockets, "explicit rejection cannot start a new name-addressed socket").toHaveLength(1);
    await page.screenshot({ path: info.outputPath(`c1-${failure}.png`), fullPage: true });
    // A later store-only fault cannot revive the rejected owner either.
    home.state.failure = "store";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#assistant-setting-error")).toHaveText("remote focus store unreadable");
    await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
    expect(home.sockets).toHaveLength(1);
    await page.reload();
    await home.ready();
    await expect(page.locator("#assistant-setting-error")).toHaveText("remote focus store unreadable");
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
    expect(home.sockets, "cached rejection survives reload followed by a store-only error").toHaveLength(1);
    home.state.failure = "none";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#assistant-content .focus-nudge")).toHaveText(/^remote focus read /);
    await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeEnabled();
    await expect.poll(() => home.sockets.length).toBe(2);
  } finally { home.release(); }
});
