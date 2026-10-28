import { expect, test } from "@playwright/test";
import { openSettingsFromUi, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test("session-list discovery line shows only while unproven or failing; healthy detail stays in Settings", async ({ page }) => {
  await page.route("https://**", route => route.abort());
  let mode: "ok" | "error" = "ok";
  let release: (() => void) | undefined;
  let hold = true;
  let scans = 0;
  await page.route("**/api/tailnet/v1/candidates", async route => {
    scans++;
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill(mode === "error" ? json({ error: "scan unavailable" }, 503) : json({ candidates: [] }));
  });
  const line = page.locator("[data-discovery-health]:visible");
  const rescan = async () => {
    const before = scans;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => scans).toBeGreaterThan(before);
  };

  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).first()).toBeVisible();
  // First scan in flight with no prior success: the line explains the state.
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Scanning tailnet...");
  await expect(line).toContainText("No successful discovery yet");

  hold = false; release!();
  // Healthy success: no visible line next to the sessions.
  await expect(line).toHaveCount(0);

  // A healthy background scan does not flash the line in and out.
  hold = true;
  await rescan();
  await expect(line).toHaveCount(0);
  hold = false; release!();
  await expect(line).toHaveCount(0);

  mode = "error";
  await rescan();
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Last error: scan unavailable");
  await expect(line).toContainText("Last successful discovery:");

  mode = "ok";
  await rescan();
  await expect(line).toHaveCount(0);

  // The last-success diagnostic remains on the existing Settings health surface.
  await openSettingsFromUi(page);
  await expect(page.locator("#discover-status")).toContainText("Last successful discovery:");
  await expect(page.locator("#discover-status")).toHaveAttribute("role", "status");
});
