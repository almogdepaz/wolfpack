import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const peerOrigin = "https://scroll-peer.example.ts.net";
type SessionFixture = { name: string; identity: Record<string, unknown>; runtimeState: Record<string, unknown>; [key: string]: unknown };
type TouchSample = { moves: number; cancelled: number; trusted: number };

async function realisticFocus(page: Page, needsInput = true) {
  await page.route("https://**", route => route.abort());
  const sessions = (template: SessionFixture, machine: string) => Array.from({ length: 16 }, (_, i) => ({ ...template,
    name: `${machine}-project-${String(i).padStart(2, "0")}`,
    identity: { ...template.identity, wolfpackSessionId: `mock:${machine}-${i}`, projectPath: `/work/${machine}-project-${i}` },
    runtimeState: { ...template.runtimeState, state: needsInput && i < 3 ? "needs-input" : i < 8 ? "working" : "idle", inputKind: needsInput && i < 3 ? "question" : undefined,
      authority: "program", stale: false, unseen: true, changedAt: new Date().toISOString() },
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
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    const instrumented = window as Window & { focusTouch: TouchSample };
    instrumented.focusTouch = { moves: 0, cancelled: 0, trusted: 0 };
    document.addEventListener("touchmove", event => {
      const sample = instrumented.focusTouch; sample.moves++; if (event.defaultPrevented) sample.cancelled++; if (event.isTrusted) sample.trusted++;
    }, { passive: true });
  });
}
async function ready(page: Page) {
  await page.goto(server.baseUrl);
  await expect.poll(() => page.locator("#session-list .card").count()).toBeGreaterThanOrEqual(32);
  await expect(page.locator("#dashboard-focus .focus-next > li")).toHaveCount(3);
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
    return { viewport: innerHeight, banner: measure("dashboard-focus"), page: measure("sessions-view"), list: measure("session-list"), controls: measure("session-dashboard-controls"), canvases: document.querySelectorAll("#sessions-view canvas").length, touch: (window as Window & { focusTouch: TouchSample }).focusTouch };
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
