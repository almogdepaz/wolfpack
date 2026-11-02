import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers.ts";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ canonicalSessionIds: true }); });
test.afterAll(async () => { await server?.close(); });
async function draft(page: Page, value: string) {
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill(value);
}
const peerOrigin = "https://organization-peer.example.ts.net";
const peerInstallation = "22222222-2222-4222-8222-222222222222";
const peerSession = "33333333-3333-4333-8333-333333333333";
const organization = { group: "remote", tags: ["host-only"], revision: 2 };

for (const transition of ["offline", "replacement"] as const) test(`organization is pinned to verified peer plus UUID and fences a delayed save after host ${transition}`, async ({ page }) => {
  let online = true, installationId = peerInstallation;
  let release!: () => void, started!: () => void;
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
      expect(route.request().postDataJSON()).toEqual({ sessionId: peerSession, expectedRevision: 2, group: "remote draft" });
      started(); await gate;
      return route.fulfill({ headers, json: { sessionId: peerSession, organization: { ...organization, group: "remote draft", revision: 3 } } });
    }
    return route.fulfill({ status: 404, headers });
  });
  await page.goto(server.baseUrl);
  const peer = page.locator(`.machine-group[data-machine="n-organization-peer:${peerInstallation}"]`).filter({ visible: true }).first();
  await peer.getByRole("button", { name: "Move test-project to group", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("remote");
  await draft(page, "remote draft"); await page.getByRole("button", { name: "Move", exact: true }).click(); await pending;
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
  if (transition === "offline") online = false; else installationId = "44444444-4444-4444-8444-444444444444";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alert")).toContainText("no longer available"); release();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("remote draft");
  await expect(page.getByRole("dialog", { name: "Move test-project to group" })).toBeVisible();
  await expect(page.locator('.machine-group[data-machine=""]').filter({ visible: true }).first()).not.toContainText("remote draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.matches('[data-action="organize-session"]'))).toBe(false);
});

test("older and unreadable organization projections disable editing without disabling terminals", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    for (const session of data.sessions) { if (session.name === "test-project") delete session.organization; else session.organization = { status: "unavailable" }; }
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  const unsupported = page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first();
  await expect(unsupported).toBeDisabled(); await expect(unsupported).toHaveAttribute("title", "Organization unsupported on this host");
  await expect(page.getByText("Grouping unsupported", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse Grouping unsupported", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move another-project to group", exact: true }).filter({ visible: true }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first()).toBeEnabled();
});

test("metadata refresh updates needs-you duplicates and preserves their exact action focus", async ({ page, request }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    data.sessions.find((s: any) => s.name === "test-project").runtimeState = { state: "needs-input", authority: "manifest", freshness: "fresh", source: "local-manifest", stale: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  const buttons = page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true });
  await expect(buttons).toHaveCount(2);
  const identities = await page.locator('#session-list .machine-group:not(.needs-you) .card').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.sessionOrderId).sort());
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "external update", tags: ["one", "two", "three"] } })).ok()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('#session-list .session-label-group[data-group="external update"]')).toContainText("test-project");
  await expect(buttons).toHaveCount(2);
  // Attention remains visible even when its canonical group is collapsed.
  await page.locator('#session-list').getByRole("button", { name: "Collapse Group “external update”", exact: true }).click();
  await expect(page.locator('#session-list .needs-you').getByRole("button", { name: "Move test-project to group", exact: true })).toBeVisible();
  await page.locator('#session-list').getByRole("button", { name: "Expand Group “external update”", exact: true }).click();
  for (const owner of [".machine-group:not(.needs-you)", ".needs-you"]) {
    const button = page.locator(`#session-list ${owner}`).getByRole("button", { name: "Move test-project to group", exact: true });
    const original = await button.elementHandle(); expect(original).not.toBeNull(); await button.click();
    await draft(page, `saved ${owner}`); await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false); await expect(button).toBeFocused();
    const opener = await button.elementHandle(); await button.click();
    const latest = await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json();
    expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: latest.organization.revision, group: `external ${owner}` } })).ok()).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => opener!.evaluate(element => element.isConnected)).toBe(false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible(); await expect(button).toBeFocused();
  }
  expect(await page.locator('#session-list .machine-group:not(.needs-you) .card').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.sessionOrderId).sort())).toEqual(identities);
});

test("mobile drawer shares saved organization and its touch editor", async ({ page, request }, info) => {
  test.skip(info.project.name === "desktop", "mobile drawer ownership only");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "drawer group", tags: ["one", "two", "three"] } })).ok()).toBe(true);
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click(); await page.locator('#session-chip').click();
  const drawer = page.locator('#session-drawer'); await expect(drawer).toHaveClass(/open/); await expect(drawer).toContainText("drawer group");
  const button = drawer.getByRole("button", { name: "Move test-project to group", exact: true });
  await drawer.getByRole("button", { name: "Collapse Group “drawer group”", exact: true }).tap();
  await expect(button).not.toBeVisible();
  await expect(drawer.getByRole("button", { name: "Expand Group “drawer group”", exact: true })).toBeFocused();
  await drawer.getByRole("button", { name: "Expand Group “drawer group”", exact: true }).tap();
  await button.tap(); await expect(page.getByLabel("Group", { exact: true })).toHaveValue("drawer group");
  await page.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(button).toBeFocused();
  const original = await button.elementHandle(); expect(original).not.toBeNull(); await button.tap();
  await draft(page, "drawer saved"); await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false); await expect(button).toBeFocused();
  const focused = await button.elementHandle();
  const latest = await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json();
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: latest.organization.revision, group: "drawer refresh" } })).ok()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => focused!.evaluate(element => element.isConnected)).toBe(false); await expect(button).toBeFocused();
  await page.screenshot({ path: info.outputPath("organization-drawer.png") });
});

test("an open organization draft disables saving when refreshed storage becomes unreadable", async ({ page, request }) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "valid persisted" } })).ok()).toBe(true);
  const path = join(server.home, ".wolfpack", "session-organization", `${session.sessionId}.json`), original = readFileSync(path);
  try {
    await page.goto(server.baseUrl);
    await page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first().click();
    await draft(page, "retained unreadable draft"); writeFileSync(path, "broken");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator(`[data-action="organize-session"][data-session-id="${session.sessionId}"]`).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained unreadable draft");
    await expect(page.getByRole("alert")).toContainText("no longer available");
  } finally { writeFileSync(path, original); }
});

test("cancelled pending save cannot replace a subsequently opened session editor", async ({ page }) => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/session-control/organization", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); // Persistence may succeed before the browser sees a response.
    started(); await gate; await route.fulfill({ response });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first().click();
  await draft(page, "pending original"); await page.getByRole("button", { name: "Move", exact: true }).click(); await pending;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Move another-project to group", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Move another-project to group", exact: true })).toBeVisible(); release();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Move another-project to group", exact: true })).toBeVisible();
});

for (const invalid of ["uuid", "metadata"] as const) test(`organization rejects ${invalid} mismatches from both move and review responses`, async ({ page }) => {
  await page.route("**/api/session-control/organization**", route => {
    const sessionId = route.request().method() === "POST" ? route.request().postDataJSON().sessionId : new URL(route.request().url()).searchParams.get("sessionId");
    return route.fulfill({ json: { sessionId: invalid === "uuid" ? "11111111-1111-4111-8111-111111111111" : sessionId, organization: { group: "bad response", tags: invalid === "metadata" ? ["bad\u0000tag"] : [], revision: 99 } } });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first().click();
  await draft(page, "retained response draft"); await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("uncertain");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained response draft");
  await expect(page.locator('#session-list .session-label-group[data-group="bad response"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Could not read" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use latest", exact: true })).not.toBeVisible();
});
