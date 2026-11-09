import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
const episode = "2026-11-09T12:00:00.000Z";
const draft = "Continue with the approved plan;  keep the scope unchanged.";
let machine: string;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
async function write(page: Page, ops: unknown[]) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const response = await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function seed(page: Page, done = false) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  machine = current.installationId;
  await write(page, [
    ...current.document.intentions.map((i: { id: string }) => ({ type: "drop", id: i.id })),
    { type: "add", intention: { id: "ship", title: "Ship the focus assistant", project: "/work/focus", sessions: ["mock:prompt-project", "mock:another-project"] } },
    { type: "add", intention: { id: "later", title: "Plan tomorrow" } },
    { type: "next", author: "assistant", rows: [
      { ref: { machine, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "suggest", reason: done ? "Looks finished — mark the intention done?" : "The approved plan is ready to continue", ...(done ? { doneIntention: "ship" } : { suggestion: draft }) },
      { ref: { machine, sessionId: "mock:another-project" }, stoppedAt: episode, verdict: "quiet", reason: "Nothing here needs your input" },
    ] },
  ]);
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); const body = await response.json();
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => ["assistant", "prompt-project", "another-project"].includes(s.name));
    for (const s of body.sessions) if (s.name !== "assistant") {
      s.identity.projectPath = "/work/focus";
      s.runtimeState = { ...s.runtimeState, state: done || s.name === "another-project" ? "done" : "needs-input", inputKind: done ? undefined : "question", changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0, stale: false, freshness: "fresh" };
    }
    await route.fulfill({ response, json: body });
  });
}

for (const width of [1440, 1280, 390]) test(`triage ${width}: exact draft, reason, quiet suppression and consistent surfaces; user tap sends once`, async ({ page }, info) => {
  test.skip(info.project.name === "desktop" ? width === 390 : width !== 390, "viewport belongs to the matching project");
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await seed(page);
  const sends: { session: string; text: string }[] = [];
  await page.route("**/api/session-control/send", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, session: "prompt-project", sessionId: "mock:prompt-project", delivery: "delivered", outcome: "submitted", observedMs: 10 } });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(2);
  await expect(block.locator(".focus-next > li").first()).toContainText(draft);
  await expect(block.locator(".focus-next")).not.toContainText("another-project");
  await expect(block).toContainText(/ordered (now|\d+m) ago/);
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("2 next:");
  await expect(page.locator("#sidebar-assistant .assistant-tile-next")).toContainText("The approved plan is ready to continue");
  expect(sends).toEqual([]);
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(":scope > h2").first()).toHaveText("next 2");
  const row = view.locator(".focus-next > li").first();
  await expect(row.locator("summary")).toContainText("The approved plan is ready to continue");
  await expect(row.locator("summary")).not.toContainText("Ship the focus assistant");
  await expect(row.locator(".focus-draft")).toContainText(`to prompt-project`);
  await expect(row.locator(".focus-draft p")).toHaveText(draft);
  expect(await row.locator(".focus-draft p").innerText(), "the visible draft preserves exact spacing").toBe(draft);
  await expect(view.locator(".focus-next")).toContainText("new · by rules");
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.locator("#assistant-view").evaluate(el => { el.scrollTop = 0; });
  expect((await new AxeBuilder({ page }).include("#assistant-content").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`triage-${width}-suggest-quiet.png`), fullPage: true });
  await row.locator("summary").click();
  await expect(row.locator(".focus-card-body")).toContainText("Ship the focus assistant");
  await row.getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  await expect(row).toContainText("sent to prompt-project");
  await expect(row.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeDisabled();
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ session: "mock:prompt-project", text: draft });
  await write(page, [{ type: "note", text: "force a fresh focus revision" }]);
  await page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus" && response.request().method() === "GET");
  await expect(row).toContainText("sent to prompt-project");
  await expect(row.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeDisabled();
  expect(sends).toHaveLength(1);
});

test("done suggestion uses the existing done/undo operations, never sends", async ({ page }) => {
  await seed(page, true);
  const sends: unknown[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/session-control/send") sends.push(request.postDataJSON()); });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await view.getByRole("button", { name: "Mark done: Ship the focus assistant", exact: true }).click();
  await expect(view.locator(".focus-done")).toContainText("Ship the focus assistant");
  await expect(view.locator(".focus-next")).not.toContainText("Looks finished — mark the intention done?");
  await view.getByRole("button", { name: "Undo done: Ship the focus assistant", exact: true }).click();
  const saved = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(saved.document.intentions.find((i: { id: string }) => i.id === "ship").done).toBe(false);
  expect(sends).toEqual([]);
});

test("intention-ref suggestions put the reason on the row and the intention inside the card", async ({ page }) => {
  await seed(page);
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { intentionId: "later" }, verdict: "suggest", reason: "Tomorrow is ready — mark the plan done?", doneIntention: "later" }] }]);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const row = page.locator("#assistant-content .focus-next > li").filter({ hasText: "Tomorrow is ready" });
  await expect(row.locator("summary")).not.toContainText("Plan tomorrow");
  await row.locator("summary").click();
  await expect(row.locator(".focus-card-body")).toContainText("Plan tomorrow");
  await row.getByRole("button", { name: "Mark done: Plan tomorrow", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-done")).toContainText("Plan tomorrow");
});

test("a user-tap suggestion traverses the real session-send route and reports its unverified outcome", async ({ page }) => {
  await seed(page);
  await page.goto(server.baseUrl);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/session-control/send");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  const sent = await response;
  expect(sent.request().postDataJSON()).toMatchObject({ session: "mock:prompt-project", text: draft });
  expect(sent.status()).toBe(200);
  expect(await sent.json()).toMatchObject({ session: "prompt-project", sessionId: "mock:prompt-project", outcome: "unverified" });
  await expect(page.locator("#dashboard-focus")).toContainText("delivery unconfirmed · check the session");
});

async function triagePeer(page: Page) {
  const id = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const origin = "https://focus-peer.example.ts.net";
  const state = { listing: "ready" as "ready" | "unavailable" | "empty" };
  const json = (body: unknown) => ({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [{ hostname: "focus-peer.example.ts.net", tailnetNodeId: "n-peer", origin, online: true }] })));
  await page.route(`${origin}/api/machine`, route => route.fulfill(json({ protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-peer", installationId: id, displayName: "focus peer", origin }, wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"] })));
  await page.route(`${origin}/api/backend`, async route => {
    const response = await route.fetch({ url: `${server.baseUrl}/api/backend` });
    await route.fulfill({ response, ...json(await response.json()) });
  });
  await page.route(`${origin}/api/sessions`, async route => {
    if (state.listing === "unavailable") return route.fulfill({ status: 503, ...json({ error: "broker not connected" }) });
    const response = await route.fetch({ url: `${server.baseUrl}/api/sessions` }); const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.name = "remote-worker"; s.identity.wolfpackSessionId = "mock:remote-session";
    s.runtimeState = { ...s.runtimeState, state: "done", changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 };
    await route.fulfill({ response, ...json({ sessions: state.listing === "empty" ? [] : [s] }) });
  });
  return { id, state };
}

test("R2: known peer suggestions survive a broker/list outage, but not an authoritative empty list", async ({ page }) => {
  await seed(page);
  const peer = await triagePeer(page);
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { machine: peer.id, sessionId: "mock:remote-session" }, stoppedAt: episode, verdict: "suggest", reason: "Remote recommendation", suggestion: draft }] }]);
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "Remote recommendation" });
  await expect(row.getByRole("button", { name: "Send suggestion to remote-worker", exact: true })).toBeEnabled();
  peer.state.listing = "unavailable";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(`.machine-group.offline[data-machine="n-peer:${peer.id}"]`).first()).toBeVisible();
  await expect(row).toContainText("not reached");
  await expect(row.locator(".focus-action")).toBeDisabled();
  peer.state.listing = "empty";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(row).toHaveCount(0);
});

test("R1: a newer needs-you episode stays visible and disabled when the local list fails", async ({ page }) => {
  await seed(page);
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { machine, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "quiet", reason: "No input needed on the old stop" }] }]);
  let phase: "stopped" | "attention" | "unavailable" = "stopped";
  await page.route("**/api/sessions", async route => {
    if (phase === "unavailable") return route.fulfill({ status: 503, json: { error: "broker not connected" } });
    const response = await route.fetch(); const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.runtimeState = { ...s.runtimeState, state: phase === "stopped" ? "done" : "needs-input", changedAt: phase === "stopped" ? episode : "2026-11-09T12:01:00Z", stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const rows = page.locator("#dashboard-focus .focus-next");
  await expect(rows).not.toContainText("prompt-project");
  phase = "attention";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const row = rows.locator("li").filter({ hasText: "prompt-project" });
  await expect(row.locator(".focus-action")).toBeEnabled();
  phase = "unavailable";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(row.locator(".focus-action")).toBeDisabled();
  await expect(row).toContainText("question");
});

test("L3: unknown installation suggestions do not become permanent placeholders", async ({ page }) => {
  await seed(page);
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { machine: "unreachable-peer", sessionId: "remote-session" }, stoppedAt: episode, verdict: "suggest", reason: "Review the remote recommendation when it reconnects", suggestion: draft }] }]);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-next")).not.toContainText("Review the remote recommendation");
});

test("L4: actual list --json facts and the ui agree on the episode without session-route fixtures", async ({ page }, info) => {
  // Populate the real observer first; the CLI must consume its bounded list projection.
  await page.request.get(`${server.baseUrl}/api/sessions`);
  const cliRoot = info.outputPath("cli-state"); mkdirSync(cliRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(cliRoot, "config.json"), JSON.stringify({ devDir: server.home, port: server.port }), { mode: 0o600 });
  const list = JSON.parse(execFileSync("bun", ["src/cli/index.ts", "list", "--json"], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_TEST: "1", WOLFPACK_DIR: cliRoot }, encoding: "utf8" }));
  const target = list.sessions.find((s: { session: string }) => s.session === "prompt-project");
  expect(target.runtime.state).toBe("needs-input");
  expect(target.lastLineTrust).toBe("untrusted-data");
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  await write(page, [
    ...current.document.intentions.map((i: { id: string }) => ({ type: "drop", id: i.id })),
    { type: "add", intention: { id: "list-goal", title: "List agreement", sessions: [target.sessionId] } },
    { type: "next", author: "assistant", rows: [{ ref: { machine: target.machine, sessionId: target.sessionId }, stoppedAt: target.runtime.changedAt.replace("Z", "+00:00"), verdict: "needs-you", reason: "Bounded list episode agrees with the ui" }] },
  ]);
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "Bounded list episode agrees" });
  await expect(row).toBeVisible();
  await row.locator("summary").click();
  await expect(row.locator(".focus-card-body")).toContainText(target.lastLine);
  await expect(row).not.toContainText("new · by rules");
});

test("expired triage returns quiet stops to rules and names the expiry", async ({ page }) => {
  await seed(page);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    delete body.routines;
    body.document.next.updatedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus")).toContainText("by rules · order expired");
  await expect(page.locator("#dashboard-focus .focus-next")).toContainText("another-project");
  await expect(page.locator("#dashboard-focus .focus-next")).not.toContainText(draft);
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("3 next:");
});

for (const mode of ["send", "done"] as const) test(`R4/L1: an expired visible ${mode} action cannot become another row's action`, async ({ page }) => {
  await seed(page, mode === "done");
  const mutations: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/session-control/send", "/api/focus", "/api/session-control/ack"].includes(path)) mutations.push(path);
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  const button = view.getByRole("button", { name: mode === "send" ? "Send suggestion to prompt-project" : "Mark done: Ship the focus assistant", exact: true });
  await expect(button).toBeEnabled();
  // One task advances the merge clock and taps the old DOM before a repaint/poll can run.
  await button.evaluate(el => { const before = Date.now; Date.now = () => before() + 5 * 3600_000; (el as HTMLButtonElement).click(); });
  await expect(page.locator("#assistant-view")).toBeVisible();
  await expect(view).toContainText("by rules · order expired");
  await expect(page.locator("#focus-status")).toContainText("action changed");
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
  expect(mutations).toEqual([]);
  const saved = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(saved.document.intentions.find((i: { id: string }) => i.id === "ship").done).not.toBe(true);
});

test("R4: a newly reordered merge still sends only the target and draft on the tapped row", async ({ page }) => {
  await seed(page);
  let sent: unknown;
  await page.route("**/api/session-control/send", async route => { sent = route.request().postDataJSON(); await route.fulfill({ json: { outcome: "submitted" } }); });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeEnabled();
  await write(page, [{ type: "next", author: "assistant", rows: [
    { ref: { intentionId: "later" }, verdict: "needs-you", reason: "Review tomorrow first" },
    { ref: { machine, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "suggest", reason: "Continue second", suggestion: draft },
  ] }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(block).toContainText("Continue second");
  await block.getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  expect(sent).toMatchObject({ session: "mock:prompt-project", text: draft });
});

for (const outcome of ["submitted", "unverified"] as const) test(`R3: ${outcome} receipt survives reordered refs, equivalent timestamps and reload`, async ({ page }) => {
  await seed(page);
  let sends = 0;
  await page.route("**/api/session-control/send", async route => {
    sends++;
    await route.fulfill({ json: { ok: true, outcome, delivery: outcome === "submitted" ? "delivered" : "unverified", observedMs: 1 } });
  });
  await page.goto(server.baseUrl);
  const button = page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { sessionId: "mock:prompt-project", machine }, stoppedAt: episode.replace("Z", "+00:00"), verdict: "suggest", reason: "Same draft, new formatting", suggestion: draft }] }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#dashboard-focus")).toContainText("Same draft, new formatting");
  await expect(button).toBeDisabled();
  await page.reload();
  await expect(button).toBeDisabled();
  await expect(page.locator("#dashboard-focus")).toContainText(outcome === "submitted" ? "sent to prompt-project" : "delivery unconfirmed");
  expect(sends).toBe(1);
});

test("an uncertain user send stays visible and cannot be tapped again", async ({ page }) => {
  await seed(page);
  await page.route("**/api/session-control/send", route => route.fulfill({ json: { ok: true, outcome: "unverified", delivery: "unverified", observedMs: 1 } }));
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  await expect(page.locator("#dashboard-focus")).toContainText("delivery unconfirmed · check the session");
  await expect(page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeDisabled();
});
