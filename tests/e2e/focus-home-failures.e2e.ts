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
    await expect(page.locator("#assistant-pane")).toBeHidden();
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
    await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
    await expect.poll(() => home.sockets.length).toBe(2);
  } finally { home.release(); }
});

for (const failure of ["candidate offline", "handshake abort", "home absent", "timeout"] as const) test(`F1: ${failure} reports the remote home offline, not a store fault`, async ({ page }, info) => {
  test.setTimeout(45_000); // the timeout case exercises the real 15-second fetch deadline
  const home = await remoteFocusHome(page, server);
  try {
    await home.openHealthy();
    if (failure === "home absent") {
      home.state.present = false;
      await page.reload();
      await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    } else if (failure === "timeout") {
      home.state.failure = "timeout";
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect.poll(home.held).toBeGreaterThan(0);
    } else {
      if (failure === "candidate offline") home.state.online = false;
      else home.state.handshakeFails = true;
      // Discovery's existing minimum refresh interval is one second.
      await page.waitForTimeout(1_100);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator(`.machine-group.offline[data-machine="${home.machine}"]`).first()).toBeVisible();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await expect(page.locator("#assistant-content .focus-header")).toContainText("focus home offline · read-only", { timeout: failure === "timeout" ? 20_000 : 5_000 });
    const counts = await page.locator("#assistant-content > h2 small").first().innerText();
    await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText(`offline · ${counts}`);
    await expect(page.locator("#assistant-pane-empty")).toContainText("focus home is offline. the terminal reconnects when it is back.");
    await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Add an intention" })).toBeDisabled();
    expect(home.sockets).toHaveLength(1);
    await page.screenshot({ path: info.outputPath(`f1-${failure.replaceAll(" ", "-")}.png`), fullPage: true });
  } finally { home.release(); }
});
