import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFocus } from "../../src/focus-contract";
import { start, skipIfNoBroker, type BrokerTestServer, type BrokerTestOwnership } from "./broker-helpers";

let server: BrokerTestServer;
let ownership: BrokerTestOwnership | undefined;
let root: string;
let sessionId: string;
const session = "pane-real";
test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  root = mkdtempSync(join(tmpdir(), "focus-pane-real-"));
  mkdirSync(join(root, "project"));
  const isolated = { HOME: root, WOLFPACK_DIR: join(root, ".wolfpack"), WOLFPACK_DEV_DIR: root };
  server = await start({ envOverrides: isolated, brokerEnvOverrides: isolated, onOwnership: owner => { ownership = owner; } });
  const response = await fetch(`${server.baseUrl}/api/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: "project", cmd: "shell", sessionName: session }) });
  expect(response.ok, await response.text()).toBe(true);
  const list = await (await fetch(`${server.baseUrl}/api/sessions`)).json();
  sessionId = list.sessions.find((s: { name: string }) => s.name === session).identity.wolfpackSessionId;
});
test.afterAll(async () => {
  await ownership?.teardown();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function focus(page: Page) {
  // Only the assistant descriptor is synthetic: HTTP auth, ticket, viewer
  // ownership, snapshot/reflow, stdin and output use the real server + broker.
  await page.route(url => url.pathname === "/api/focus", route => route.fulfill({ json: {
    home: "private", installationId: "private", local: true, revision: 0, document: emptyFocus(),
    assistant: { enabled: true, folder: root, state: "idle", session, sessionId, queued: 0 },
  } }));
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
async function screen(page: Page) {
  const response = await page.request.get(`${server.baseUrl}/api/session-control/snapshot?sessionId=${sessionId}`);
  return response.text();
}
const pane = (page: Page) => page.getByRole("region", { name: "Assistant terminal", exact: true });

test("real broker pane handover preserves input and never conflicts with its own full-screen viewer", async ({ page }, info) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(info.project.name !== "desktop", "desktop embedded surface");
  const geometry: string[] = [];
  page.on("websocket", ws => {
    if (!ws.url().includes("/ws/pty")) return;
    ws.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      const message = JSON.parse(frame.payload);
      if (["attach", "resize", "layout_stable"].includes(message.type)) geometry.push(`${message.cols}x${message.rows}`);
    });
  });
  await focus(page);
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  expect(new Set(geometry).size, "real broker receives only the settled first-open geometry").toBe(1);
  expect(await pane(page).locator("canvas").evaluate(el => el.getBoundingClientRect().width <= el.parentElement!.clientWidth)).toBe(true);
  await pane(page).locator("canvas").click();
  await page.keyboard.type("printf 'pane-before-%s\\n' handover\n");
  await expect.poll(() => screen(page)).toContain("pane-before-handover");
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect(page.locator("#desktop-terminal-container")).toHaveClass(/hydrated/);
  await expect(page.locator(".viewer-conflict-overlay")).toHaveCount(0);
  await page.locator("#desktop-terminal-container canvas").click();
  await page.keyboard.type("printf 'pane-after-%s\\n' handover\n");
  await expect.poll(() => screen(page)).toContain("pane-after-handover");
  await page.locator("#sidebar-assistant").click();
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  await expect(page.locator(".viewer-conflict-overlay")).toHaveCount(0);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(0);
});

test("real broker pane waits for explicit takeover and frees the slot while hidden", async ({ page, context }, info) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(info.project.name !== "desktop", "desktop embedded surface");
  const owner = await context.newPage();
  let ownerTakeovers = 0, ownerReady = 0;
  owner.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    socket.on("framesent", frame => { if (typeof frame.payload === "string" && JSON.parse(frame.payload).type === "take_control") ownerTakeovers++; });
    socket.on("framereceived", frame => { if (typeof frame.payload === "string" && JSON.parse(frame.payload).type === "pty_ready") ownerReady++; });
  });
  try {
    await focus(owner);
    await expect(owner.locator("#assistant-pty")).toHaveClass(/hydrated/);
    await focus(page);
    const conflict = pane(page).getByRole("dialog", { name: "Session active on another device", exact: true });
    await expect(conflict).toBeVisible();
    await expect(pane(owner).locator(".viewer-conflict-overlay")).toHaveCount(0);
    await conflict.getByRole("button", { name: "Take Control", exact: true }).click();
    await expect(conflict).toHaveCount(0);
    await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
    await expect(pane(owner).locator(".viewer-conflict-overlay")).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(pane(page).locator("canvas")).toHaveCount(0);
    // Release the displaced owner and reattach normally, with no takeover
    // authority. This only succeeds if hiding the challenger actually freed the slot.
    await owner.evaluate(() => {
      for (const value of ["hidden", "visible"]) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    await expect.poll(() => ownerReady).toBe(2);
    await expect(pane(owner).locator(".viewer-conflict-overlay")).toHaveCount(0);
    await expect(owner.locator("#assistant-pty")).toHaveClass(/hydrated/);
    expect(ownerTakeovers).toBe(0);
  } finally { await owner.close(); }
});

for (const motion of ["normal", "fallback race"] as const) test(`real broker pane restores exact unpinned geometry: ${motion}`, async ({ page }, info) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(info.project.name !== "desktop", "desktop sidebar layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "0"));
  let sockets = 0;
  const geometry: { type: string; cols: number; rows: number; resizeId?: number }[] = [];
  const acknowledgements: { cols: number; rows: number; resizeId: number }[] = [];
  page.on("websocket", ws => {
    if (!ws.url().includes("/ws/pty")) return;
    sockets++;
    ws.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      const message = JSON.parse(frame.payload);
      if (["attach", "resize", "layout_stable"].includes(message.type)) geometry.push(message);
    });
    ws.on("framereceived", frame => {
      if (typeof frame.payload !== "string") return;
      const message = JSON.parse(frame.payload);
      if (message.type === "resize_ack") acknowledgements.push(message);
    });
  });
  await focus(page);
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  const bounds = () => pane(page).locator("canvas").evaluate(canvas => ({ canvas: canvas.getBoundingClientRect().width, mount: canvas.parentElement!.clientWidth }));
  const initial = await bounds();
  const initialGeometry = geometry.at(-1)!;
  if (motion === "fallback race") await page.evaluate(() => { document.getElementById("desktop-sidebar")!.style.transition = "margin-left 600ms ease"; });
  const stages = [];
  try {
    for (const action of ["Pin sidebar", "Unpin sidebar"]) {
      if (action === "Pin sidebar") await page.mouse.move(1, 100);
      const before = geometry.length;
      await page.getByRole("button", { name: action, exact: true }).click();
      await expect.poll(() => geometry.length - before).toBe(1);
      const sent = geometry[before]!;
      expect(sent.type).toBe("resize");
      expect(sent.resizeId).toBeGreaterThan(0);
      await expect.poll(() => acknowledgements.some(ack => ack.resizeId === sent.resizeId && ack.cols === sent.cols && ack.rows === sent.rows)).toBe(true);
      stages.push({ action, geometry: sent, box: await bounds() });
      await expect.poll(async () => { const box = await bounds(); return box.canvas <= box.mount; }).toBe(true);
      if (action === "Unpin sidebar") {
        await expect.poll(bounds, { message: "the same mount and font regain the original fitted canvas" }).toEqual(initial);
        expect(sent).toMatchObject({ cols: initialGeometry.cols, rows: initialGeometry.rows });
      }
      expect(geometry.slice(before)).toHaveLength(1);
    }
    // Settlement must also release observer suppression, without reconnecting.
    const before = geometry.length;
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect.poll(() => geometry.length).toBeGreaterThan(before);
    await expect.poll(async () => { const box = await bounds(); return box.canvas <= box.mount; }).toBe(true);
    await pane(page).locator("canvas").click();
    const marker = crypto.randomUUID();
    await page.keyboard.type(`printf 'pane-unpin-%s\\n' ${marker}\n`);
    await expect.poll(() => screen(page)).toContain(`pane-unpin-${marker}`);
    expect(sockets).toBe(1);
  } finally {
    writeFileSync(info.outputPath("native-unpin.json"), JSON.stringify({ initial, initialGeometry, motion, stages, final: await bounds(), sockets, geometry, acknowledgements }, null, 2));
  }
});
