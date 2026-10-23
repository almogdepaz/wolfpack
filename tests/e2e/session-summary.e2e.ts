import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function sessionsFixture(page: Page, sessionCount = 2, machineCount = 1) {
  const peerOrigin = "https://summary-peer.example.ts.net";
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: machineCount === 2 ? [{
    hostname: "summary-peer.example.ts.net", tailnetNodeId: "summary-peer", origin: peerOrigin, online: true,
  }] : [] } }));
  await page.route(`${peerOrigin}/api/machine`, route => route.fulfill({
    headers: { "Access-Control-Allow-Origin": "*" },
    json: {
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: { tailnetNodeId: "summary-peer", installationId: "2af8af29-c4fe-44f9-8a99-2a0e35952d74", displayName: "Summary peer", origin: peerOrigin },
      wolfpack: { version: "test" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    },
  }));
  await page.route(`${peerOrigin}/api/info`, route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.route("**/api/sessions", route => route.fulfill({
    status: machineCount === 0 ? 503 : 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    json: { sessions: route.request().url().startsWith(peerOrigin) ? [] : Array.from({ length: sessionCount }, (_, index) => ({
      name: index === 0 ? "test-project" : "another-project",
      identity: { wolfpackSessionId: `summary-${index}` },
      runtimeState: { state: index === 0 ? "needs-input" : "working", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false },
    })) },
  }));
}

for (const [sessions, machines, expected] of [
  [0, 0, "0 sessions across 0 machines · 0 need you"],
  [0, 1, "0 sessions across 1 machine · 0 need you"],
  [1, 1, "1 session across 1 machine · 1 need you"],
  [2, 1, "2 sessions across 1 machine · 1 need you"],
  [1, 2, "1 session across 2 machines · 1 need you"],
  [2, 2, "2 sessions across 2 machines · 1 need you"],
] as const) {
  test(`summary independently pluralizes ${sessions} sessions and ${machines} machines`, async ({ page }) => {
    await sessionsFixture(page, sessions, machines);
    await page.goto(server.baseUrl);
    const summary = page.locator("#session-summary");
    await expect(summary).toHaveText(expected);
    await expect(summary.locator("strong")).toHaveCount(1);
    await expect(summary.locator("strong")).toHaveText(`${sessions && machines ? 1 : 0} need you`);
    await expect(summary.locator("strong")).toHaveCSS("color", "rgb(246, 195, 92)");
    await expect(summary.locator("strong")).toHaveCSS("font-weight", "500");
  });
}

for (const width of [320, 390]) {
  test(`mobile heading reclaims space and summary/search stay aligned at ${width}`, async ({ page }, info) => {
    test.skip(info.project.name !== "iphone-14");
    await page.setViewportSize({ width, height: 844 });
    await sessionsFixture(page);
    await page.goto(server.baseUrl);
    await expect(page.locator("#session-list .machine-group:not(.needs-you) .card")).toHaveCount(2);
    const heading = page.locator(".session-heading h1");
    await expect(heading).toHaveText("Sessions"); // Semantic element stays in the DOM.
    await expect.soft(heading).toBeHidden();
    await expect.soft(heading).toHaveCSS("display", "none");
    await expect.soft(page.locator("#session-summary")).toHaveCSS("margin-top", "0px");
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return { heading: rect(".session-heading h1"), group: rect(".session-heading"), summary: rect("#session-summary"), search: rect(".mobile-session-search summary"), controls: rect("#session-dashboard-controls"), filter: rect("#dashboard-session-filter"), scrollWidth: document.documentElement.scrollWidth };
    });
    expect.soft(geometry.heading.height).toBe(0);
    expect.soft(geometry.group.height).toBe(geometry.summary.height);
    expect.soft(geometry.summary.y).toBe(geometry.group.y);
    expect.soft(Math.abs(geometry.summary.y + geometry.summary.height / 2 - geometry.search.y - geometry.search.height / 2)).toBeLessThanOrEqual(1);
    expect(geometry.summary.right).toBeLessThanOrEqual(geometry.search.x);
    expect(geometry.search.right).toBeLessThanOrEqual(width - 16);
    expect(Math.min(geometry.summary.y, geometry.search.y) - geometry.controls.y).toBe(4);
    expect(geometry.controls.height).toBe(Math.max(geometry.summary.height, geometry.search.height) + 16 + geometry.filter.height + 4 + 12);
    expect(geometry.filter.y - Math.max(geometry.summary.bottom, geometry.search.bottom)).toBe(16);
    expect(geometry.scrollWidth).toBe(width);
    await info.attach("dashboard-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath(`dashboard-${width}.png`) });

    const toggle = page.locator(".mobile-session-search summary");
    await toggle.tap();
    const search = page.locator("#mobile-search");
    await expect(search).toBeVisible();
    const box = (await search.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await search.fill("another");
    const cards = page.locator("#session-list .machine-group:not(.needs-you) .card:visible");
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText("another-project");
    await expect(page.locator("#session-summary")).toHaveText("2 sessions across 1 machine · 1 need you");
    await toggle.tap(); // Close the existing search popover before using the filters underneath.
    await expect(search).toBeHidden();
    const need = page.locator('#dashboard-session-filter [data-session-card-view="need"]');
    await need.tap();
    await expect(need).toHaveAttribute("aria-pressed", "true");
    await expect(cards).toHaveCount(0);
    await need.tap();
    await expect(cards).toHaveCount(1);
    await toggle.tap();
    await search.fill("");
    await expect(cards).toHaveCount(2);
    await toggle.tap();
    await expect(search).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("desktop retains its visible semantic Sessions heading and summary spacing", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await sessionsFixture(page);
  await page.goto(server.baseUrl);
  const heading = page.getByRole("heading", { name: "Sessions", exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS("font-size", "28px");
  await expect(page.locator("#session-summary")).toHaveCSS("margin-top", "5px");
  await expect(page.locator("#session-summary")).toHaveText("2 sessions across 1 machine · 1 need you");
  expect((await heading.boundingBox())!.height).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("dashboard-desktop.png") });
});

test("dashboard receives the generated source-bound app and stylesheet", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const files = ["app.bundle.js", "styles.css"];
  const responses = files.map(file => page.waitForResponse(response => new URL(response.url()).pathname === `/${file}`));
  await page.goto(server.baseUrl);
  const bindings = [];
  for (const response of await Promise.all(responses)) {
    const file = new URL(response.url()).pathname.slice(1);
    const bytes = await response.body();
    const source = readFileSync(`public/${file}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(bytes.equals(source)).toBe(true);
    expect(new URL(response.url()).searchParams.get("v")).toBe(sha256.slice(0, 16));
    bindings.push({ file, url: response.url(), bytes: bytes.length, sha256 });
  }
  await info.attach("served-asset-bindings", { body: JSON.stringify(bindings), contentType: "application/json" });
});
