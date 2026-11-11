import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function fixture(page: Page, denied = false) {
  const episode = new Date().toISOString();
  await page.addInitScript(({ denied }) => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
    localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "0");
    if (denied) {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key === "wolfpack-focus-desktop-expanded-v1") throw new Error("blocked"); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key === "wolfpack-focus-desktop-expanded-v1") throw new Error("blocked"); return set.call(this, key, value); };
    }
  }, { denied });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const seed = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...Array.from({ length: 32 }, (_, i) => ({ ...seed,
      name: `work-${i}`, identity: { ...seed.identity, wolfpackSessionId: `mock:work-${i}`, projectPath: `/work/project-${i}` },
      runtimeState: { ...seed.runtimeState, state: i === 0 ? "needs-input" : i === 1 ? "done" : "working", inputKind: i === 0 ? "question" : undefined,
        authority: "program", stale: false, unseen: true, changedAt: episode, ...(i === 1 ? { stoppedAt: episode, stoppedSequence: 5, acknowledgedSequence: 0 } : {}) },
    }))];
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions = [];
    body.document.nudge = { text: "Review the pending decision, then continue the approved work.", author: "assistant", updatedAt: episode };
    body.document.next = { updatedAt: episode, author: "assistant", rows: [
      { ref: { machine: body.installationId, sessionId: "mock:work-1" }, stoppedAt: episode, verdict: "suggest", reason: "The approved work is ready", suggestion: "Continue the approved work." },
    ] };
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect.poll(() => page.locator("#session-list .card").count()).toBeGreaterThanOrEqual(32);
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (id: string) => { const el = document.getElementById(id)!; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scrollTop: el.scrollTop }; };
    return { banner: box("dashboard-focus"), controls: box("session-dashboard-controls"), list: box("session-list") };
  });
}
for (const width of [1440, 1280]) test(`desktop disclosure shares main/sidebar state and persists at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop disclosure");
  await page.setViewportSize({ width, height: 900 });
  await fixture(page);
  const banner = page.locator("#dashboard-focus");
  const toggle = banner.locator('[data-focus-action="toggle-dashboard"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator("#session-list").evaluate(el => { el.scrollTop = 180; });
  const before = await geometry(page);
  expect(before.list.scrollTop).toBe(180);
  await page.screenshot({ path: info.outputPath(`expanded-${width}.png`), fullPage: true });
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("1 need you · 1 reply ready");
  await expect(page.locator("#dashboard-focus-details")).toBeHidden();
  const target = (await toggle.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
  const after = await geometry(page);
  expect(after.banner.height).toBeLessThanOrEqual(48);
  expect(after.controls.y - before.controls.y).toBeCloseTo(after.banner.height - before.banner.height, 0);
  expect(after.list.width).toBe(before.list.width);
  expect(after.list.x).toBe(before.list.x);
  expect(after.list.scrollTop).toBe(before.list.scrollTop);
  await page.screenshot({ path: info.outputPath(`collapsed-${width}.png`), fullPage: true });
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus(); await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await banner.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const tile = page.locator("#sidebar-assistant");
  const sidebarToggle = tile.locator('[data-focus-action="toggle-dashboard"]');
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  const pane = await page.locator("#assistant-pane").boundingBox();
  await sidebarToggle.focus(); await page.keyboard.press("Enter");
  await expect(sidebarToggle).toBeFocused();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await expect(tile).toContainText("1 need you · 1 reply ready");
  await expect(page.locator("#sidebar-assistant-details")).toBeHidden();
  await expect(page.locator("#assistant-content .focus-nudge")).toBeVisible();
  expect(await page.locator("#assistant-pane").boundingBox()).toEqual(pane);
  const sideTarget = (await sidebarToggle.boundingBox())!;
  expect(sideTarget.width).toBeGreaterThanOrEqual(44); expect(sideTarget.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`sidebar-collapsed-${width}.png`), fullPage: true });
  expect((await new AxeBuilder({ page }).include("#sidebar-assistant").include("#assistant-content").analyze()).violations).toEqual([]);
  await page.locator("#assistant-back").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // An explicit mobile choice is independent of desktop's saved collapse, in both directions.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width, height: 900 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await banner.getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  await expect(tile.locator('[data-focus-action="view"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`sidebar-expanded-${width}.png`), fullPage: true });
});
for (const surface of ["main", "sidebar"]) test(`Space activation survives a data refresh in the ${surface} disclosure`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop keyboard");
  await fixture(page);
  if (surface === "sidebar") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const toggle = page.locator(`${surface === "main" ? "#dashboard-focus" : "#sidebar-assistant"} [data-focus-action="toggle-dashboard"]`);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.down("Space");
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.nudge = { text: "The data refresh completed.", author: "assistant", updatedAt: new Date().toISOString() };
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#dashboard-focus .focus-nudge")).toHaveText("The data refresh completed.");
  await page.keyboard.up("Space");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("desktop disclosure retains an in-memory choice when storage is denied", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop storage");
  await fixture(page, true);
  const toggle = page.locator('#dashboard-focus [data-focus-action="toggle-dashboard"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
