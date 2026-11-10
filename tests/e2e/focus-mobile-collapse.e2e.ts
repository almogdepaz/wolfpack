import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const peerOrigin = "https://scroll-peer.example.ts.net";
type SessionFixture = { name: string; identity: Record<string, unknown>; runtimeState: Record<string, unknown>; [key: string]: unknown };
type TouchSample = { moves: number; cancelled: number; trusted: number };
declare global { interface Window { focusMobileCollapseTouch?: TouchSample } }

async function realisticFocus(page: Page, needsInput = true, triage: "none" | "suggest" | "needs-you" = "none") {
  const episode = new Date().toISOString();
  await page.route("https://**", route => route.abort());
  const sessions = (template: SessionFixture, machine: string) => Array.from({ length: 16 }, (_, i) => ({ ...template,
    name: `${machine}-project-${String(i).padStart(2, "0")}`,
    identity: { ...template.identity, wolfpackSessionId: `mock:${machine}-${i}`, projectPath: `/work/${machine}-project-${i}` },
    runtimeState: { ...template.runtimeState, state: triage === "suggest" && machine === "local" && i === 0 ? "done" : needsInput && i < 3 ? "needs-input" : i < 8 ? "working" : "idle", inputKind: needsInput && i < 3 ? "question" : undefined,
      authority: "program", stale: false, unseen: true, changedAt: episode,
      ...(triage === "suggest" && machine === "local" && i === 0 ? { stoppedAt: episode, stoppedSequence: 5, acknowledgedSequence: 0 } : {}) },
  }));
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...sessions(body.sessions.find((s: SessionFixture) => s.name === "prompt-project"), "local")];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "scroll-peer.example.ts.net", tailnetNodeId: "n-scroll", origin: peerOrigin, online: true }] } }));
  await page.route(`${peerOrigin}/api/machine`, route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-scroll", installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74", displayName: "Studio", origin: peerOrigin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  } }));
  await page.route(`${peerOrigin}/api/sessions`, async route => {
    const response = await route.fetch({ url: server.baseUrl + "/api/sessions" }); const body = await response.json();
    body.sessions = sessions(body.sessions.find((s: SessionFixture) => s.name === "prompt-project"), "studio");
    await route.fulfill({ response, headers: { "Access-Control-Allow-Origin": "*" }, json: body });
  });
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions = Array.from({ length: 6 }, (_, i) => ({ id: `today-${i}`, title: ["Ship the release safely", "Review the database migration", "Resolve the broker leak", "Finish the mobile dashboard", "Document the rollout", "Follow up on the incident"][i], done: false,
      createdAt: new Date().toISOString(), sessions: [`mock:local-${i}`, `mock:studio-${i}`] }));
    body.document.nudge = { text: "Several agents are waiting for a decision. Review the migration, confirm release access, then continue the rollout.", updatedAt: new Date().toISOString(), author: "assistant" };
    if (triage !== "none") body.document.next = { updatedAt: episode, author: "assistant", rows: [
      triage === "suggest" ? { ref: { machine: body.installationId, sessionId: "mock:local-0" }, stoppedAt: episode, verdict: "suggest", reason: "The rollout is ready to continue", suggestion: "Continue with the approved rollout." }
        : { ref: needsInput ? { machine: body.installationId, sessionId: "mock:local-0" } : { intentionId: "today-0" }, ...(needsInput ? { stoppedAt: episode } : {}), verdict: "needs-you", reason: "Choose the rollout window" },
    ] };
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    window.focusMobileCollapseTouch = { moves: 0, cancelled: 0, trusted: 0 };
    document.addEventListener("touchmove", event => {
      const sample = window.focusMobileCollapseTouch;
      if (!sample) throw new Error("touch observer not initialized"); sample.moves++; if (event.defaultPrevented) sample.cancelled++; if (event.isTrusted) sample.trusted++;
    }, { passive: true });
  });
}
async function ready(page: Page) {
  await page.goto(server.baseUrl);
  await expect.poll(() => page.locator("#session-list .card").count()).toBeGreaterThanOrEqual(32);
  await expect(page.locator("#dashboard-focus")).toBeVisible();
}
async function touchScroll(page: Page, startY?: number) {
  const viewport = page.viewportSize()!;
  const cdp = await page.context().newCDPSession(page);
  const x = viewport.width * .6, y = startY ?? viewport.height - 140;
  const distance = Math.min(360, viewport.height - 260);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 12; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - distance * step / 12 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally { await cdp.detach(); }
}
async function metrics(page: Page) {
  return page.evaluate(() => {
    const measure = (id: string) => { const el = document.getElementById(id)!; const r = el.getBoundingClientRect(); const css = getComputedStyle(el); return { client: el.clientHeight, scroll: el.scrollHeight, top: r.top, bottom: r.bottom, height: r.height, scrollTop: el.scrollTop, overflow: css.overflowY, position: css.position, flex: css.flex }; };
    const touch = window.focusMobileCollapseTouch;
    if (!touch) throw new Error("touch observer not initialized");
    return { viewport: innerHeight, banner: measure("dashboard-focus"), page: measure("sessions-view"), list: measure("session-list"), controls: measure("session-dashboard-controls"), canvases: document.querySelectorAll("#sessions-view canvas").length, touch };
  });
}
async function touchToLastCard(page: Page) {
  const last = page.locator("#session-list .card").last();
  for (let i = 0; i < 20; i++) {
    const box = await last.boundingBox();
    if (box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height - 84) return;
    await touchScroll(page);
  }
  await expect(last).toBeInViewport({ ratio: .9 });
}

for (const scenario of [
  { triage: "suggest" as const, needsInput: false, label: "0 need you · 1 suggestion" },
  { triage: "needs-you" as const, needsInput: false, label: "1 need you" },
  { triage: "needs-you" as const, needsInput: true, label: "6 need you" },
]) test(`phone attention includes ${scenario.triage} (${scenario.needsInput ? "session" : "no session input"}) without double-counting`, async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "mobile triage disclosure");
  await realisticFocus(page, scenario.needsInput, scenario.triage); await ready(page);
  const toggle = page.locator('#dashboard-focus [data-focus-action="toggle-dashboard"]');
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText(scenario.label);
  await expect(toggle.locator("span").last()).toBeVisible();
  await expect(page.locator("#dashboard-focus-details")).toBeHidden();
  await toggle.tap();
  if (scenario.triage === "suggest") {
    await expect(page.locator("#dashboard-focus .focus-draft p")).toHaveText("Continue with the approved rollout.");
    await expect(page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to local-project-00", exact: true })).toBeVisible();
  }
});

test("phone disclosure keeps its choice across reload, shows attention, and has a 44px target", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "mobile disclosure");
  await realisticFocus(page); await ready(page);
  const toggle = page.getByRole("button", { name: /Collapse assistant/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("6 need you");
  const target = await toggle.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  expect(target!.width).toBeGreaterThanOrEqual(44);
  await toggle.tap();
  const expand = page.getByRole("button", { name: /Expand assistant/ });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#dashboard-focus-details")).toBeHidden();
  expect((await page.locator("#dashboard-focus").boundingBox())!.height).toBeLessThanOrEqual(48);
  await page.screenshot({ path: info.outputPath(`collapsed-${page.viewportSize()!.width}.png`) });
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await page.reload();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.tap();
  await expect(page.locator("#dashboard-focus-details")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`expanded-${page.viewportSize()!.width}.png`) });
  await page.reload();
  await expect(page.getByRole("button", { name: /Collapse assistant/ })).toHaveAttribute("aria-expanded", "true");
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  const phone = page.viewportSize()!;
  await page.getByRole("button", { name: /Collapse assistant/ }).tap();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#dashboard-focus-details")).toBeVisible();
  await expect(page.getByRole("button", { name: /Expand assistant|Collapse assistant/ })).toHaveCount(0);
  await page.setViewportSize(phone);
  await expect(page.getByRole("button", { name: /Expand assistant/ })).toHaveAttribute("aria-expanded", "false");
});

test("quiet phones default collapsed; desktop keeps the full banner without a toggle", async ({ page }, info) => {
  await realisticFocus(page, false); await ready(page);
  if (info.project.name === "desktop") {
    await expect(page.getByRole("button", { name: /Expand assistant|Collapse assistant/ })).toHaveCount(0);
    await expect(page.locator("#dashboard-focus .focus-header")).toBeVisible();
    await expect(page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true })).toBeVisible();
    writeFileSync(info.outputPath("desktop-geometry.json"), JSON.stringify(await metrics(page), null, 2));
    await page.screenshot({ path: info.outputPath("desktop-unchanged.png") });
  } else {
    await expect(page.getByRole("button", { name: /Expand assistant/ })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#dashboard-focus-details")).toBeHidden();
  }
});

test("phone disclosure works when its storage access throws", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "mobile preference");
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === "wolfpack-focus-mobile-expanded-v1") throw new Error("blocked"); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === "wolfpack-focus-mobile-expanded-v1") throw new Error("blocked"); return set.call(this, key, value); };
  });
  await realisticFocus(page, false); await ready(page);
  await page.getByRole("button", { name: /Expand assistant/ }).tap();
  await expect(page.locator("#dashboard-focus-details")).toBeVisible();
  await page.getByRole("button", { name: /Collapse assistant/ }).tap();
  await expect(page.locator("#dashboard-focus-details")).toBeHidden();
});

test("collapsed phones can touch-scroll to the last session", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "mobile scroll surface");
  await realisticFocus(page); await ready(page);
  await page.getByRole("button", { name: /Collapse assistant/ }).tap();
  await touchToLastCard(page);
});

test("Sessions touch scroll from the expanded assistant reaches the last session", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone reproduction / touch regression");
  await realisticFocus(page); await ready(page);
  const before = await metrics(page);
  await page.screenshot({ path: info.outputPath("expanded-before-touch.png") });
  const startY = Math.min(page.viewportSize()!.height - 140, before.banner.bottom - 12);
  await touchScroll(page, startY);
  const after = await metrics(page);
  writeFileSync(info.outputPath("scroll-geometry.json"), JSON.stringify({ before, after }, null, 2));
  await page.screenshot({ path: info.outputPath("expanded-after-touch.png") });
  expect(after.canvases).toBe(0);
  expect(after.touch.trusted).toBeGreaterThan(0);
  expect(after.touch.cancelled).toBe(0);
  expect(after.page.scrollTop + after.list.scrollTop, "a vertical gesture over the banner must scroll the Sessions content").toBeGreaterThan(before.page.scrollTop + before.list.scrollTop);
  await touchToLastCard(page);
});
