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

test("QA-29: the pane status remains a whole instruction at the supported breakpoint", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane status");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await openFocus(page);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await hydrated(page);
    const status = pane(page).getByRole("status");
    await expect(status).toHaveText("click to talk");
    const size = await status.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      return { available: el.clientWidth, text: range.getBoundingClientRect().width };
    });
    expect(size.available, `${width}: instruction fits without ellipsis`).toBeGreaterThanOrEqual(size.text);
    await page.screenshot({ path: info.outputPath(`qa29-status-${width}.png`), animations: "disabled" });
  }
});

test("QA-22/23: narrow pane rows yield context before kind text and pane controls stay on one row", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane geometry");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.name = "broker-leak";
    session.identity.projectPath = "/work/broker-leak";
    session.runtimeState = { ...session.runtimeState, state: "needs-input", inputKind: "permission" };
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions.find((i: { id: string }) => i.id === "ship").title = "fix the broker fd leak";
    await route.fulfill({ response, json: body });
  });
  await openFocus(page);
  await hydrated(page);
  const title = page.locator("#assistant-content .focus-next .focus-title").first();
  await expect(title).toContainText("broker-leak permission");
  const measure = await title.evaluate(el => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, "broker-leak permission".length);
    return { available: el.clientWidth, label: range.getBoundingClientRect().width };
  });
  await page.screenshot({ path: info.outputPath("pane-1280.png"), animations: "disabled" });
  expect.soft(measure.available).toBeGreaterThanOrEqual(measure.label);
  const focus = (await pane(page).getByRole("button", { name: "Focus terminal", exact: true }).boundingBox())!;
  const back = (await pane(page).getByRole("button", { name: "Back to list", exact: true }).boundingBox())!;
  expect.soft(back.y).toBeCloseTo(focus.y, 0);
  expect((await pane(page).boundingBox())!.width).toBeGreaterThanOrEqual(420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("pane: two columns at 1280+, one column below, clean breakpoint remount and captures", async ({ page }, info) => {
  const stats = transport(page);
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await openFocus(page);
  const shots = process.env.WOLFPACK_FOCUS_SHOTS ?? join(process.cwd(), ".plans/screenshots/slice-c");
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
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await hydrated(page);
    // Resize settlement is asynchronous; capture the fitted terminal, not the old-width canvas.
    await expect.poll(() => page.locator("#assistant-pty").evaluate(el => el.querySelector("canvas")!.getBoundingClientRect().width <= el.clientWidth)).toBe(true);
    const list = (await page.locator(".assistant-column").boundingBox())!;
    const terminal = (await pane(page).boundingBox())!;
    expect(terminal.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
    expect(terminal.width).toBeGreaterThanOrEqual(width === 1440 ? 480 : 420);
    expect(list.width).toBeLessThanOrEqual(640);
    expect(list.width).toBeGreaterThanOrEqual(520);
    expect(await page.locator('#assistant-content .focus-today .focus-title').first().evaluate(el => el.clientWidth)).toBeGreaterThan(90);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, `assistant-${width}.png`), fullPage: true });
  }
  for (const width of [1279, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(pane(page)).toBeHidden();
    await expect(page.locator("#assistant-pane-skip")).toBeHidden();
    await expect.poll(() => stats.live).toBe(0);
    await page.screenshot({ path: join(shots, `assistant-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await hydrated(page);
  await expect.poll(() => stats.live).toBe(1);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
});

for (const outage of ["home", "broker"] as const) test(`QA-27: ${outage} outage explains the empty pane and hides ineffective controls`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  let down = false;
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    if (down && outage === "home") return route.abort();
    const response = await route.fetch();
    const body = await response.json();
    if (down) body.assistant = { ...body.assistant, state: "unknown", session: undefined, sessionId: undefined, unavailableReason: "sessions unavailable; reconnecting to the terminal broker" };
    await route.fulfill({ response, json: body });
  });
  await openFocus(page);
  await hydrated(page);
  const focus = pane(page).locator("#assistant-pane-focus");
  await focus.click();
  expect(await page.locator("#assistant-pty-input").evaluate(el => el.contains(document.activeElement))).toBe(true);
  down = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#assistant-content .focus-header")).toContainText(outage === "home" ? "offline · read-only" : "sessions unavailable", { timeout: 15_000 });
  await expect(focus).toBeHidden();
  await expect(focus).toHaveAttribute("hidden", "");
  expect(await focus.evaluate(el => getComputedStyle(el).display)).toBe("none");
  await expect(page.locator("#assistant-pane-empty")).toBeVisible();
  await expect(page.locator("#assistant-pane-empty")).toContainText(outage === "home" ? "offline" : "broker");
  await expect(pane(page).locator("canvas")).toHaveCount(0);
  await expect(pane(page).getByRole("button", { name: "Back to list", exact: true })).toBeEnabled();
  await expect(page.locator(".assistant-column")).toBeFocused();
  await page.screenshot({ path: info.outputPath(`pane-${outage}-unavailable.png`), animations: "disabled" });
  const reasonInset = await page.locator("#assistant-pane-empty").evaluate(el => {
    const range = document.createRange(); range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, 1);
    return range.getBoundingClientRect().left - document.getElementById("assistant-pane-status")!.getBoundingClientRect().left;
  });
  expect.soft(Math.abs(reasonInset), "QA-31: empty reason aligns with the pane header status").toBeLessThanOrEqual(1);
  down = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await hydrated(page);
  await expect(page.locator("#assistant-pane-empty")).toBeHidden();
  await expect(focus).toBeEnabled();
  await expect(focus).toBeVisible();
});

test("QA-32: fallback focus visibly belongs inside the list, not on the pane boundary", async ({ page }, info) => {
  await openFocus(page);
  const checkbox = page.getByRole("checkbox", { name: "Done: ship the focus assistant", exact: true });
  await checkbox.focus();
  await page.keyboard.press("Space");
  const list = page.locator(".assistant-column");
  await expect(list).toBeFocused();
  for (const width of info.project.name === "desktop" ? [1440, 1280] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(list).toBeFocused();
    const cue = await list.evaluate(el => {
      const style = getComputedStyle(el);
      return { visible: el.matches(":focus-visible"), offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    expect(cue.visible).toBe(true);
    expect(cue.style).toBe("solid");
    expect(cue.width).toBeGreaterThanOrEqual(2);
    expect(cue.offset, "the complete cue is inset in the list, away from its scroll/pane edges").toBeLessThanOrEqual(-8);
    await page.screenshot({ path: info.outputPath(`qa32-list-focus-${width}.png`), animations: "disabled" });
  }
  await page.keyboard.press("Tab");
  await expect(list).not.toBeFocused();
  expect(await list.evaluate(el => el.matches(":focus-visible"))).toBe(false);
});

test("pane: one-column opening preserves the existing focus behavior", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1279 : 390, height: 900 });
  await page.addInitScript(() => {
    const state = window as unknown as { listFocuses: number };
    state.listFocuses = 0;
    document.addEventListener("focusin", event => {
      if ((event.target as HTMLElement).classList.contains("assistant-column")) state.listFocuses++;
    });
  });
  await openFocus(page);
  await expect(pane(page)).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { listFocuses: number }).listFocuses)).toBe(0);
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
  // A newly mounted projection on foreground return needs a fresh explicit focus action.
  await pane(page).locator("canvas").click();
  await visibility(page, "hidden");
  await visibility(page, "visible");
  await hydrated(page);
  expect(await page.locator(".assistant-column").evaluate(el => el.contains(document.activeElement))).toBe(true);
  await pane(page).getByRole("button", { name: "Focus terminal", exact: true }).click();
  await page.keyboard.type("explicit focus");
  await expect.poll(() => stats.binary).toBeGreaterThan(before);
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

test("pane: leaving during the asynchronous WASM mount never opens a late viewer", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop pane only");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/ghostty-web.bundle.js*", async route => { await held; await route.continue(); });
  const stats = transport(page);
  await openFocus(page);
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  expect(stats.opened).toBe(0);
  release();
  await page.locator("#assistant-setting-open").click();
  await hydrated(page);
  await expect.poll(() => stats.live).toBe(1);
  expect(stats.opened).toBe(1);
  expect(stats.max).toBe(1);
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
  console.log("pane refresh counts", JSON.stringify({ visible, hidden }));
});
