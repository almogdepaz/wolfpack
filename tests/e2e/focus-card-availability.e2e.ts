import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
const episode = "2026-11-11T10:00:00Z";
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
for (const runtimeState of ["needs-input", "failed"]) test(`R3: cached ${runtimeState} triage survives peer outage, disabled and counted`, async ({ page }) => {
  const id = "2af8af29-c4fe-44f9-9a99-9a0e35952d74", origin = "https://focus-peer.example.ts.net";
  let unavailable = false;
  const json = (body: unknown) => ({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [{ hostname: "focus-peer.example.ts.net", tailnetNodeId: "n-peer", origin, online: true }] })));
  await page.route(`${origin}/api/machine`, route => route.fulfill(json({ protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-peer", installationId: id, displayName: "focus peer", origin }, wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"] })));
  await page.route(`${origin}/api/backend`, async route => { const response = await route.fetch({ url: `${server.baseUrl}/api/backend` }); await route.fulfill({ response, ...json(await response.json()) }); });
  await page.route(`${origin}/api/sessions`, async route => {
    if (unavailable) return route.fulfill({ status: 503, ...json({ error: "broker not connected" }) });
    const response = await route.fetch({ url: `${server.baseUrl}/api/sessions` }); const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.name = "remote-worker"; s.identity.wolfpackSessionId = "mock:remote-session";
    s.runtimeState = { ...s.runtimeState, state: runtimeState, changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 };
    await route.fulfill({ response, ...json({ sessions: [s] }) });
  });
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "next", author: "assistant", rows: [{ ref: { machine: id, sessionId: "mock:remote-session" }, stoppedAt: episode, verdict: "needs-you", reason: "Remote user decision required" }] }] } })).ok()).toBe(true);
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "Remote user decision required" });
  await expect(row).toHaveCount(1);
  unavailable = true; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(`.machine-group.offline[data-machine="n-peer:${id}"]`).first()).toBeVisible();
  await expect(page.locator("#dashboard-focus .focus-quiet")).toContainText("focus peer not reached");
  await expect(row).toHaveCount(1);
  await expandFocusCard(row);
  await expect(row.getByRole("button", { name: "Open remote-worker", exact: true })).toBeDisabled();
  await expect(row.getByRole("textbox")).not.toBeEditable();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-content > h2").first()).toHaveText("next 2 need you");
});
for (const parentPresent of [true, false]) test(`R4: child finish follows full inventory parent liveness (${parentPresent})`, async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    const make = (name: string, state: string, pinned: boolean, parent?: string) => ({ ...template, name, pinned,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}`, ...(parent ? { parentSession: { wolfpackSessionId: `mock:${parent}`, wolfpackSessionName: parent } } : {}) },
      runtimeState: { ...template.runtimeState, state, changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 } });
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...(parentPresent ? [make("pinned-parent", "working", true)] : []), make("child-finish", "done", false, "pinned-parent")];
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "child-finish" });
  await expect(row).toHaveCount(parentPresent ? 0 : 1);
});
