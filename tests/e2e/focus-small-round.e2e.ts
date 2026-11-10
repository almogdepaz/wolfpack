import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function openAssistant(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}

test("QA-36: today context yields instead of duplicating a project-named chip", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    body.sessions.push(...["broker-leak", "worker-1", "worker-2", "worker-3"].map((name, index) => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:chip${index}`, projectPath: "/work/broker-leak" } })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions = [{ ...body.document.intentions[0], title: "fix the broker fd leak", sessions: [0, 1, 2, 3].map(i => `mock:chip${i}`) }];
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1279 : 390, height: 900 });
  await openAssistant(page);
  for (const width of info.project.name === "desktop" ? [1279, 1280, 1440] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator("#assistant-content .focus-today > li");
    if (info.project.name === "desktop") await expect(row.locator(".focus-for")).toBeHidden();
    await expect(row.locator("[data-focus-session]:visible").first()).toContainText("broker-leak");
    await page.screenshot({ path: info.outputPath(`qa36-project-${width}.png`), animations: "disabled" });
  }
});

test("QA-35: next-row times fit completely or are hidden", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.name = "broker-leak-worker-3";
    session.runtimeState = { ...session.runtimeState, changedAt: new Date(Date.now() - 3 * 3600000).toISOString(), state: "needs-input", inputKind: "permission" };
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1280 : 390, height: 900 });
  await openAssistant(page);
  for (const width of info.project.name === "desktop" ? [1280, 1440] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    const stamp = page.locator("#assistant-content .focus-next > li").filter({ hasText: "broker-leak-worker-3" }).locator(".focus-title small");
    await expect(stamp).toHaveCount(1);
    if (width === 1280) await expect(stamp).toBeHidden();
    await expect.poll(() => stamp.evaluate(el => {
      if (getComputedStyle(el).display === "none") return true;
      return el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right + 1;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath(`qa35-time-${width}.png`), animations: "disabled" });
  }
});

test("QA-34: hover sidebar overlays without shrinking the hydrated pane", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop hover/pane");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "0"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAssistant(page);
  const pane = page.locator("#assistant-pty");
  await expect(pane).toHaveClass(/hydrated/);
  await expect.poll(() => pane.evaluate(el => el.querySelector("canvas")!.getBoundingClientRect().width <= el.clientWidth)).toBe(true);
  const before = (await pane.boundingBox())!.width;
  await page.mouse.move(2, 450);
  await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
  await page.locator("#desktop-sidebar").evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  await expect.poll(() => pane.evaluate(el => el.querySelector("canvas")!.getBoundingClientRect().width <= el.clientWidth)).toBe(true);
  expect((await pane.boundingBox())!.width).toBeCloseTo(before, 0);
  await page.screenshot({ path: info.outputPath("qa34-hover-1440.png"), animations: "disabled" });
});
