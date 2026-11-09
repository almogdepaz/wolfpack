import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  await focus(page);
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
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
    await pane(owner).getByRole("button", { name: "Take Control", exact: true }).click();
    await expect(pane(owner).locator(".viewer-conflict-overlay")).toHaveCount(0);
    await expect(owner.locator("#assistant-pty")).toHaveClass(/hydrated/);
  } finally { await owner.close(); }
});
