import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

for (const reading of [false, true]) test(`QA-13: the sidebar name separates ${reading ? "reading" : "counted"} status and next without repeating next`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.state = "idle";
    body.routines.catchingUp = reading ? { machines: 1, since: null } : null;
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  const tile = page.locator('#sidebar-assistant [data-focus-action="view"]');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAccessibleName(reading ? /^assistant\s*, reading next\s*: prompt-project question$/ : /^assistant\s*, \d+ next\s*: prompt-project question$/);
  // S3: punctuation is spoken-only, and the original small visual label remains.
  const visibleText = await tile.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest(".visually-hidden")) parts.push(node.textContent ?? "");
    }
    return parts.join(" ");
  });
  expect.soft(visibleText).not.toMatch(/[,:]/);
  await expect.soft(tile.locator(".assistant-tile-next i[aria-hidden=true]")).toHaveText("next");
  await expect.soft(tile.locator(".assistant-tile-next i")).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#sidebar-assistant").analyze()).violations).toEqual([]);
  const shots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `corrections-sidebar-${reading ? "reading" : "counted"}-1440.png`), fullPage: true });
});

test("N3: a resize burst coalesces assistant renders to animation frames", async ({ page }) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.queued = 1;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#focus-status")).toHaveText("1 queued");
  const changes = await page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(document.getElementById("focus-status")!, { childList: true });
    for (let i = 0; i < 40; i++) window.dispatchEvent(new Event("resize"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    observer.disconnect();
    return count;
  });
  expect(changes).toBeGreaterThan(0);
  expect(changes).toBeLessThanOrEqual(2);
});

test("QA-5: the sidebar assistant remains reachable with no other sessions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => s.name === "assistant");
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.setViewportSize({ width: 1279, height: 900 });
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
  await expect(page.locator("#sidebar-session-list .card")).toHaveCount(0);
  await page.locator("#sidebar-assistant").click();
  await expect(page.locator("#assistant-view")).toBeVisible();
});
