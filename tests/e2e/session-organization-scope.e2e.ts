import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers.ts";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ canonicalSessionIds: true }); });
test.afterAll(async () => { await server?.close(); });

const peerOrigin = "https://organization-peer.example.ts.net";
const peerInstallation = "22222222-2222-4222-8222-222222222222";
const peerSession = "33333333-3333-4333-8333-333333333333";
const organization = { group: "remote", tags: ["host-only"], revision: 2 };

for (const transition of ["offline", "replacement"] as const) test(`organization is pinned to verified peer plus UUID and fences a delayed save after host ${transition}`, async ({ page }) => {
  let online = true;
  let installationId = peerInstallation;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "organization-peer.example.ts.net", tailnetNodeId: "n-organization-peer", origin: peerOrigin, online }] } }));
  await page.route(`${peerOrigin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (path === "/api/machine") return route.fulfill({ headers, json: { protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-organization-peer", installationId, displayName: "organization peer", origin: peerOrigin }, wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"] } });
    if (path === "/api/backend") return route.fulfill({ headers, json: { backend: "broker", ready: true } });
    if (path === "/api/sessions") return route.fulfill({ headers, json: { sessions: [{ name: "test-project", lastLine: "remote terminal", identity: { wolfpackSessionId: peerSession }, organization }] } });
    if (path === "/api/session-control/organization") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ sessionId: peerSession, expectedRevision: 2, group: "remote draft", tags: ["host-only"] });
      started(); await gate;
      return route.fulfill({ headers, json: { sessionId: peerSession, organization: { ...organization, group: "remote draft", revision: 3 } } });
    }
    return route.fulfill({ status: 404, headers });
  });
  await page.goto(server.baseUrl);
  const peer = page.locator(`.machine-group[data-machine="n-organization-peer:${peerInstallation}"]`).filter({ visible: true }).first();
  await peer.getByRole("button", { name: "Organize test-project", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("remote");
  await page.getByLabel("Group", { exact: true }).fill("remote draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await pending;
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  if (transition === "offline") online = false;
  else installationId = "44444444-4444-4444-8444-444444444444";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alert")).toContainText("no longer available");
  release();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("remote draft");
  await expect(page.getByRole("dialog", { name: "Organize test-project" })).toBeVisible();
  const local = page.locator('.machine-group[data-machine=""]').filter({ visible: true }).first();
  await expect(local).not.toContainText("remote draft");
});

test("older and unreadable organization projections disable editing without disabling terminals", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const session of data.sessions) {
      if (session.name === "test-project") delete session.organization;
      else session.organization = { status: "unavailable" };
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first()).toBeDisabled();
  await expect(page.getByText("Organization unsupported on this host").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Organize another-project", exact: true }).filter({ visible: true }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first()).toBeEnabled();
});

test("metadata refresh updates needs-you duplicates without moving canonical session order", async ({ page, request }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const session = data.sessions.find((s: any) => s.name === "test-project");
    session.runtimeState = { state: "needs-input", authority: "manifest", freshness: "fresh", source: "local-manifest", stale: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  const buttons = page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true });
  await expect(buttons).toHaveCount(2);
  const order = await page.locator('#session-list .machine-group:not(.needs-you) .card-name-text').allTextContents();
  const sessions = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "external update" } })).ok()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const cards = page.locator('.card').filter({ has: page.getByRole("button", { name: "Organize test-project", exact: true }) }).filter({ visible: true });
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) await expect(card).toContainText("external update");
  expect(await page.locator('#session-list .machine-group:not(.needs-you) .card-name-text').allTextContents()).toEqual(order);
});

test("mobile drawer shares saved organization and its touch editor", async ({ page, request }, info) => {
  test.skip(info.project.name === "desktop", "mobile drawer ownership only");
  const sessions = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "drawer group" } })).ok()).toBe(true);
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
  await page.locator('#session-chip').click();
  const drawer = page.locator('#session-drawer');
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer).toContainText("drawer group");
  await drawer.getByRole("button", { name: "Organize test-project", exact: true }).tap();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("drawer group");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("an open organization draft disables saving when refreshed storage becomes unreadable", async ({ page, request }) => {
  const sessions = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "valid persisted" } })).ok()).toBe(true);
  const path = join(server.home, ".wolfpack", "session-organization", `${session.sessionId}.json`);
  const original = readFileSync(path);
  try {
    await page.goto(server.baseUrl);
    await page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first().click();
    await page.getByLabel("Group", { exact: true }).fill("retained unreadable draft");
    writeFileSync(path, "broken");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator(`[data-action="organize-session"][data-session-id="${session.sessionId}"]`).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained unreadable draft");
    await expect(page.getByRole("alert")).toContainText("no longer available");
  } finally { writeFileSync(path, original); }
});

test("cancelled pending save cannot replace a subsequently opened session editor", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/session-control/organization", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); // Persistence may succeed before the browser sees a response.
    started(); await gate;
    await route.fulfill({ response });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first().click();
  await page.getByLabel("Group", { exact: true }).fill("pending original");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await pending;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Organize another-project", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Organize another-project", exact: true })).toBeVisible();
  release();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Organize another-project", exact: true })).toBeVisible();
});
