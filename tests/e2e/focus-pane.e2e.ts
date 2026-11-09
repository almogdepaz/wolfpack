import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const pane = (page: Page) => page.getByRole("region", { name: "Assistant terminal", exact: true });
async function openFocus(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-view")).toBeVisible();
}
function transport(page: Page) {
  const stats = { opened: 0, live: 0, max: 0, binary: 0, takeovers: 0, acks: [] as string[] };
  page.on("websocket", ws => {
    if (!ws.url().includes("/ws/pty")) return;
    stats.opened++; stats.live++; stats.max = Math.max(stats.max, stats.live);
    ws.on("close", () => { stats.live--; });
    ws.on("framesent", frame => {
      if (typeof frame.payload !== "string") stats.binary++;
      else if (frame.payload.includes('"take_control"')) stats.takeovers++;
    });
  });
  page.on("request", req => { if (req.url().includes("/agent-runtime-state/ack")) stats.acks.push(req.postData() ?? ""); });
  return stats;
}
async function hydrated(page: Page) {
  await expect(pane(page).locator("canvas")).toBeVisible();
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
}
async function visibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("pane: two columns at 1100+, one column below, clean breakpoint remount and captures", async ({ page }, info) => {
  const stats = transport(page);
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await openFocus(page);
  const shots = join(process.cwd(), ".plans/screenshots/slice-c");
  mkdirSync(shots, { recursive: true });
  if (info.project.name !== "desktop") {
    await expect(pane(page)).toBeHidden();
    expect(stats.opened).toBe(0);
    await page.screenshot({ path: join(shots, "assistant-390.png"), fullPage: true });
    await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
    await expect(page.locator("#assistant-terminal-header")).toBeVisible();
    await expect.poll(() => stats.live).toBe(1);
    return;
  }
  await hydrated(page);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await hydrated(page);
    const list = (await page.locator(".assistant-column").boundingBox())!;
    const terminal = (await pane(page).boundingBox())!;
    expect(terminal.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
    expect(terminal.width).toBeGreaterThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, `assistant-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1099, height: 900 });
  await expect(pane(page)).toBeHidden();
  await expect.poll(() => stats.live).toBe(0);
  await page.setViewportSize({ width: 1100, height: 900 });
  await hydrated(page);
  await expect.poll(() => stats.live).toBe(1);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
});

test("pane: attach on open, disconnect on leave/hidden, reattach on return without duplicate viewers", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  const stats = transport(page);
  await openFocus(page);
  await hydrated(page);
  await expect.poll(() => stats.live).toBe(1);
  await visibility(page, "hidden");
  await expect.poll(() => stats.live).toBe(0);
  await expect(pane(page).locator("canvas")).toHaveCount(0);
  await visibility(page, "visible");
  await hydrated(page);
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect.poll(() => stats.live).toBe(0);
  await page.locator("#assistant-setting-open").click();
  await hydrated(page);
  await expect.poll(() => stats.live).toBe(1);
  expect(stats.max).toBe(1);
});

test("pane: keyboard stays in the list, click to type, back to list never sends list input", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  const stats = transport(page);
  await openFocus(page);
  await hydrated(page);
  expect(await page.locator(".assistant-column").evaluate(el => el.contains(document.activeElement))).toBe(true);
  const add = page.getByRole("textbox", { name: "Add an intention", exact: true });
  await add.pressSequentially("list only");
  expect(stats.binary).toBe(0);
  await pane(page).locator("canvas").click();
  await page.keyboard.type("pane input");
  await expect.poll(() => stats.binary).toBeGreaterThan(0);
  const before = stats.binary;
  await pane(page).getByRole("button", { name: "Back to list", exact: true }).click();
  expect(await page.locator(".assistant-column").evaluate(el => el.contains(document.activeElement))).toBe(true);
  await add.pressSequentially("still list");
  expect(stats.binary).toBe(before);
});

test("pane: full-screen handover and tile return release the old controller before attaching", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  const stats = transport(page);
  await openFocus(page);
  await hydrated(page);
  await pane(page).locator("canvas").click();
  await page.keyboard.type("before handover");
  await expect.poll(() => stats.binary).toBeGreaterThan(0);
  const before = stats.binary;
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container")).toHaveClass(/hydrated/);
  await expect(page.locator(".viewer-conflict-overlay")).toHaveCount(0);
  await page.locator("#desktop-terminal-container canvas").click();
  await page.keyboard.type("after handover");
  await expect.poll(() => stats.binary).toBeGreaterThan(before);
  await page.locator("#sidebar-assistant").click();
  await hydrated(page);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(0);
  await expect(page.locator(".viewer-conflict-overlay")).toHaveCount(0);
  await expect.poll(() => stats.live).toBe(1);
  expect(stats.takeovers).toBe(0);
  expect(stats.max).toBe(1);
});

test("pane: existing viewer conflict waits for explicit Take Control and recovers displacement", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  const owner = await context.newPage();
  const ownerStats = transport(owner);
  try {
    await openFocus(owner);
    await owner.getByRole("button", { name: "Talk to assistant", exact: true }).click();
    await expect(owner.locator("#desktop-terminal-container")).toHaveClass(/hydrated/);
    const stats = transport(page);
    await openFocus(page);
    const overlay = pane(page).getByRole("dialog", { name: "Session active on another device", exact: true });
    await expect(overlay).toBeVisible();
    expect(stats.takeovers).toBe(0);
    expect(ownerStats.live).toBe(1);
    await overlay.getByRole("button", { name: "Take Control", exact: true }).click();
    await hydrated(page);
    await expect(overlay).toHaveCount(0);
    await expect.poll(() => ownerStats.live).toBe(0);
    expect(stats.takeovers).toBe(1);
    // The displaced pane uses the same explicit gate, never an automatic reclaim.
    await owner.locator("#desktop-conflict-overlay").getByRole("button", { name: "Take Control", exact: true }).click();
    await expect(overlay).toBeVisible();
    expect(stats.takeovers).toBe(1);
  } finally { await owner.close(); }
});

test("pane: pinned assistant never acknowledges or counts as watched work", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  const stats = transport(page);
  await openFocus(page);
  await hydrated(page);
  await pane(page).locator("canvas").click();
  await page.keyboard.type("assistant input");
  // Force a real shared refresh after the connected pane has keyboard focus.
  await visibility(page, "hidden");
  await visibility(page, "visible");
  await hydrated(page);
  expect(stats.acks).toEqual([]);
  await expect(page.locator("#assistant-content .focus-next")).not.toContainText("assistant stopped");
  await expect(page.locator('#sidebar-session-list .card-name-text').filter({ hasText: /^assistant$/ })).toHaveCount(0);
});

test("pane: uses the shared refresh cadence, no extra session/focus polling", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  test.setTimeout(60_000);
  const requests = { sessions: 0, focus: 0 };
  page.on("request", req => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/sessions") requests.sessions++;
    if (path === "/api/focus") requests.focus++;
  });
  await openFocus(page);
  await hydrated(page);
  async function windowCounts() {
    const before = { ...requests };
    // Deliberate wall-clock observation window spanning two 5-second ticks.
    await page.waitForTimeout(10_500);
    return { sessions: requests.sessions - before.sessions, focus: requests.focus - before.focus };
  }
  const visible = await windowCounts();
  for (const count of Object.values(visible)) { expect(count).toBeGreaterThanOrEqual(2); expect(count).toBeLessThanOrEqual(3); }
  await visibility(page, "hidden");
  const hidden = await windowCounts();
  expect(hidden).toEqual({ sessions: 0, focus: 0 });
});
