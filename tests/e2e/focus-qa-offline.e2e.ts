import { expandFocusCard } from "./focus-card-helpers";
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

test("row truth: broker outage has one page-voice notice, not a raw transport error", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.assistant = { ...body.assistant, state: "unknown", error: "broker not connected", queued: 3,
      unavailableReason: "sessions unavailable; reconnecting to the terminal broker" };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-header")).toContainText("sessions unavailable · focus is saved here");
  await expect(page.locator("#assistant-content")).not.toContainText("broker not connected");
  await expect(page.locator("#focus-status")).toHaveText("3 queued · sends when the broker is back");
  if (process.env.WOLFPACK_FOCUS_SHOTS) {
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-offline-broker-${info.project.name === "desktop" ? 1440 : 390}.png`), fullPage: true });
  }
});

for (const mode of ["catching", "stale", "cached"] as const) for (const today of [true, false])
  test(`row truth: ${mode} ${today ? "today omits" : "another day keeps"} weekday`, async ({ page }, info) => {
    await page.clock.install({ time: new Date("2026-11-09T12:30:00Z") });
    await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
    const at = `2026-11-${today ? "09" : "08"}T03:12:00Z`;
    let down = false;
    await page.route(url => url.pathname === "/api/focus", async route => {
      if (down) return route.abort("failed");
      const response = await route.fetch();
      const body = await response.json();
      body.document.updatedAt = at;
      body.routines = { catchingUp: mode === "catching" ? { machines: 1, since: at } : null,
        stale: mode === "stale" ? { since: at } : null, unreachable: [{ name: "laptop", since: at }], surfaced: null };
      await route.fulfill({ response, json: body });
    });
    await page.goto(server.baseUrl);
    const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus");
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
    // Opening refreshes focus; finish that healthy read before simulating a later outage.
    await (await opened).finished();
    if (mode === "cached") {
      down = true;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    const time = await page.evaluate(({ at, today }) => new Date(at).toLocaleString([], {
      weekday: today ? undefined : "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }), { at, today });
    const prefix = mode === "catching" ? "reading activity since" : mode === "stale" ? "quiet since" : "focus from";
    await expect(page.locator("#assistant-content .focus-header > span").first()).toContainText(`${prefix} ${time}`);
    if (mode !== "cached") await expect(page.locator("#assistant-content .focus-notes")).toContainText(`laptop not reached since ${time}`);
    else {
      await expect(page.locator("#assistant-content .focus-header")).toContainText("offline · read-only");
      await expect(page.locator("#focus-status")).toHaveText("");
      await expect(page.locator("#assistant-content")).not.toContainText("Failed to fetch");
    }
    if (process.env.WOLFPACK_FOCUS_SHOTS) {
      mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-time-${mode}-${today ? "today" : "other"}-${info.project.name === "desktop" ? 1440 : 390}.png`), fullPage: true });
    }
  });

for (const firstFetchFails of [false, true]) test(`P1: cold ${firstFetchFails ? "failed" : "healthy"} session fetch is connecting until its first response`, async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { coldSessionNotices: string[] }).coldSessionNotices = seen;
    new MutationObserver(() => {
      for (const header of document.querySelectorAll("#dashboard-focus .focus-header, #assistant-content .focus-header")) {
        if (header.textContent?.includes("sessions unavailable")) seen.push(header.parentElement!.id);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${server.baseUrl}/api/sessions`, async route => {
    // Startup may issue more than one request; none has settled while this gate is held.
    await gate;
    if (firstFetchFails) return route.fulfill({ status: 503, json: { error: "sessions unavailable" } });
    await route.continue();
  });
  const response = page.waitForResponse(res => res.url() === `${server.baseUrl}/api/sessions`);
  try {
    await page.goto(server.baseUrl);
    await expect(page.locator("#dashboard-focus")).toBeVisible(); // focus answered before the gated sessions fetch
    await page.waitForTimeout(800);
    const duringPending = await page.evaluate(() => [...(window as unknown as { coldSessionNotices: string[] }).coldSessionNotices]);
    release();
    await response;
    if (firstFetchFails) {
      await expect(page.locator("#dashboard-focus .focus-header")).toContainText("sessions unavailable");
      await expect(page.locator("#assistant-content .focus-header")).toContainText("sessions unavailable");
    } else {
      await expandFocusCard(page.locator("#dashboard-focus .focus-next > li").first());
      await expect(page.locator("#dashboard-focus .focus-next [data-focus-session]").first()).toBeEnabled();
      expect(await page.evaluate(() => (window as unknown as { coldSessionNotices: string[] }).coldSessionNotices)).toEqual([]);
    }
    expect(duringPending, "a pending first fetch is not an outage, including transient DOM mutations").toEqual([]);
  } finally { release(); }
});

for (const state of ["idle", "needs-input"]) test(`SF1: focus writes and ${state === "idle" ? "talk" : "needs-you"} work while only the session list is unavailable`, async ({ page }) => {
  let localDown = false;
  await page.route(`${server.baseUrl}/api/sessions`, async route => {
    if (localDown) return route.fulfill({ status: 503, json: { error: "local session list unavailable" } });
    const response = await route.fetch();
    const body = await response.json();
    const finished = body.sessions.find((s: { name: string }) => s.name === "another-project");
    finished.runtimeState = { ...finished.runtimeState, state: "done", changedAt: new Date().toISOString(), authority: "program", stale: false };
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.state = state;
    if (body.routines) body.routines.catchingUp = null;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expandFocusCard(view.locator(".focus-next > li").first());
  await expect(view.locator(".focus-next [data-focus-session]").first()).toBeEnabled();
  localDown = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(view.locator(".focus-next [data-focus-session]").first()).toBeDisabled({ timeout: 10_000 });
  await expect(view.locator(".focus-header")).toContainText("sessions unavailable", { timeout: 1_000 });
  await expect(view.locator(".focus-header")).not.toContainText("read-only");
  await view.locator(".focus-today summary .focus-title").first().click();
  await expect(view.locator(".focus-today .focus-card-body [data-focus-session]")).toHaveCount(2);
  for (const button of await view.locator("[data-focus-session]").all()) await expect(button).toBeDisabled();
  expect((await page.request.get(`${server.baseUrl}/api/focus`)).ok()).toBe(true);
  const input = view.getByRole("textbox", { name: "Add an intention" });
  await expect(input).toBeEnabled();
  const title = `Session outage focus write ${state}`;
  await input.fill(title);
  await input.press("Enter");
  const checkbox = view.getByRole("checkbox", { name: `Done: ${title}`, exact: true });
  await expect(checkbox).toBeEnabled();
  await checkbox.click();
  await expect(view.locator(".focus-done")).toContainText(title);
  await page.setViewportSize({ width: Math.min(page.viewportSize()!.width, 1279), height: 900 });
  if (state === "idle") await view.getByRole("button", { name: "Talk to assistant" }).click();
  else await view.getByRole("button", { name: /needs you · answer/ }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible({ timeout: 2_000 });
  await page.locator("#assistant-terminal-focus").click();
  localDown = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(view.locator(".focus-next [data-focus-session]").first()).toBeEnabled({ timeout: 10_000 });
  await expect(view.locator(".focus-header")).not.toContainText("sessions unavailable");
});

test("QA-18: broker-only outage leaves focus writable but terminal actions unavailable", async ({ page }) => {
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.assistant = { ...body.assistant, state: "unknown", unavailableReason: "sessions unavailable; reconnecting to the terminal broker" };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-header")).toContainText("sessions unavailable");
  await expect(view.locator(".focus-header")).not.toContainText("offline");
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toHaveAttribute("title", /reconnecting to the terminal broker/);
  const input = view.getByRole("textbox", { name: "Add an intention" });
  await expect(input).toBeEnabled();
  const title = "QA18 local focus during broker outage";
  await input.fill(title);
  await input.press("Enter");
  await view.getByRole("checkbox", { name: `Done: ${title}`, exact: true }).click();
  await expect(view.locator(".focus-done")).toContainText(title);
});

test("R3: broker outage overrides a pending catch-up on every surface and recovers without losing it", async ({ page }, info) => {
  let down = false;
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.routines.catchingUp = { machines: 1, since: null, unconfirmed: true };
    body.assistant.queued = 3;
    if (down) body.assistant = { ...body.assistant, state: "unknown", unavailableReason: "sessions unavailable; reconnecting to the terminal broker" };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  const tile = page.locator("#sidebar-assistant");
  await expect(view.locator(".focus-header")).toContainText("reading activity");
  await page.setViewportSize({ width: Math.min(page.viewportSize()!.width, 1279), height: 900 });
  await view.getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
  down = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.soft(page.locator("#assistant-terminal-state")).toHaveText("sessions unavailable");
  await page.locator("#assistant-terminal-focus").click();
  await expect(view.locator(".focus-header")).toContainText("sessions unavailable");
  await expect(page.locator("#focus-status")).toHaveText("3 queued · sends when the broker is back");
  await expect.soft(tile).not.toHaveAttribute("data-tone", "busy");
  await expect.soft(tile).toContainText("unavailable");
  await expect.soft(page.locator("#dashboard-focus .focus-spin, #assistant-content .focus-spin")).toHaveCount(0);
  await expect.soft(view.locator(".focus-nudge")).not.toHaveClass(/\bfrom\b/);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!));
  expect(cached.routines.catchingUp).toMatchObject({ machines: 1, unconfirmed: true });
  expect(cached.assistant.queued).toBe(3);
  await page.screenshot({ path: info.outputPath("broker-down-pending-catchup.png") });
  down = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(view.locator(".focus-header")).toContainText("reading activity");
  await expect(tile).toHaveAttribute("data-tone", "busy");
  await expect(tile).toContainText("reading");
  await expect(page.locator("#focus-status")).toHaveText("3 queued");
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeEnabled();
});

test("S2: a retired peer installation leaves the offline snapshot before local recovery", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  const origin = "https://focus-peer.example.ts.net";
  const oldId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const newId = "42d17268-cde1-4b14-990a-44e468ec6333";
  let replaced = false;
  let localDown = false;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [{ hostname: "focus-peer.example.ts.net", tailnetNodeId: "n-focus", origin, online: true }] })));
  await page.route(`${origin}/api/machine`, route => route.fulfill(json({
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-focus", installationId: replaced ? newId : oldId, displayName: "focus peer", origin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  })));
  await page.route(`${origin}/api/sessions`, route => route.fulfill(json({ sessions: [{
    name: replaced ? "replacement-worker" : "retired-worker",
    identity: { wolfpackSessionId: replaced ? "mock:replacement" : "mock:retired", projectPath: "/work/peer" },
    runtimeState: { state: "needs-input", authority: "program", source: "program-status", freshness: "fresh", stale: false, changedAt: new Date().toISOString() },
  }] })));
  await page.route(`${server.baseUrl}/api/sessions`, route => localDown ? route.fulfill(json({ error: "local unavailable" }, 503)) : route.continue());
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const next = page.locator("#assistant-content .focus-next");
  await expect(next).toContainText("retired-worker", { timeout: 10_000 });
  await expect(next.locator("li").filter({ hasText: "retired-worker" }).locator("summary span.focus-meta")).toContainText("peer · focus peer");
  if (process.env.WOLFPACK_FOCUS_SHOTS) await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-peer-${width}.png`), fullPage: true });
  localDown = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(next.locator("button").first()).toBeDisabled({ timeout: 10_000 });
  // Unknown/unavailable is not retirement: preserve it until a verified replacement.
  await expect(next).toContainText("retired-worker");
  replaced = true;
  await page.waitForTimeout(1_100); // the discovery refresh's existing minimum interval
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(`.machine-group[data-machine="n-focus:${newId}"]`).first()).toContainText("replacement-worker", { timeout: 10_000 });
  await expect.soft(next).not.toContainText("retired-worker", { timeout: 2_000 });
  await expect(next.locator("button").first()).toBeDisabled();
  localDown = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(next).toContainText("replacement-worker", { timeout: 10_000 });
  await expect(next).not.toContainText("retired-worker");
  await expect(next.locator("[data-focus-session]").first()).toBeEnabled();
});

test("QA-26: assistant settings explain offline state without a bare transport error", async ({ page, context }) => {
  await page.goto(server.baseUrl);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await (await opened).finished();
  await context.setOffline(true);
  // Match QA's sequence: go offline, then open settings. Mobile settings do not poll focus.
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).toContainText("offline · read-only");
  await expect(page.locator("#assistant-setting-error")).toHaveText("");
  await expect(page.locator("#assistant-setting-toggle")).toBeDisabled();
  await context.setOffline(false);
});

for (const failure of ["HTTP 500", "invalid document"] as const) test(`S1: settings retain ${failure} diagnostics and clear them on recovery`, async ({ page }) => {
  let failed = false;
  const message = failure === "HTTP 500" ? "focus store unreadable: EACCES" : "invalid focus document";
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (!failed) return route.continue();
    if (failure === "HTTP 500") return route.fulfill({ status: 500, json: { error: message } });
    const response = await route.fetch();
    const body = await response.json();
    body.document.version = 999;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await (await opened).finished();
  failed = true;
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).toContainText("focus unavailable · read-only");
  await expect(page.locator("#assistant-setting-status")).not.toContainText("offline");
  await expect(page.locator("#assistant-setting-error")).toHaveText(message);
  failed = false;
  await page.locator("#assistant-setting-open").click();
  await expect(page.locator("#assistant-content .focus-header")).not.toContainText("offline · read-only");
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-error")).toHaveText("");
});

for (const failure of ["HTTP 503", "invalid document"] as const) test(`QA-30: ${failure} keeps a verified assistant terminal live, including cached reload`, async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  let failed = false;
  const message = failure === "HTTP 503" ? "focus persistence is unreadable: EACCES" : "invalid focus document";
  let sockets = 0;
  let binary = 0;
  page.on("websocket", ws => {
    if (!ws.url().includes("/ws/pty")) return;
    sockets++;
    ws.on("framesent", frame => { if (typeof frame.payload !== "string") binary++; });
  });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (!failed) return route.continue();
    if (failure === "HTTP 503") return route.fulfill({ status: 503, json: { error: message } });
    const response = await route.fetch(); const body = await response.json();
    body.document.version = 999;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await (await opened).finished();
  const view = page.locator("#assistant-content");
  const terminal = page.locator("#assistant-pty");
  if (desktop) {
    await view.getByRole("button", { name: "Talk to assistant" }).click();
    await expect(terminal).toHaveClass(/hydrated/);
  }
  const canvas = desktop ? await terminal.locator("canvas").elementHandle() : null;
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  for (const header of ["#assistant-content .focus-header", "#dashboard-focus .focus-header"]) {
    await expect(page.locator(header)).toContainText("focus unavailable · read-only");
    await expect(page.locator(header)).not.toContainText("offline");
  }
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("focus unavailable · 1 needs you");
  await expect(view.getByRole("textbox", { name: "Add an intention" })).toBeDisabled();
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeEnabled();
  await expect(page.locator("#focus-status")).toHaveText(""); // cause belongs in settings
  if (desktop) {
    await expect(terminal).toHaveClass(/hydrated/);
    expect(await canvas!.evaluate(el => el.isConnected), "no store-fault terminal remount").toBe(true);
    expect(sockets).toBe(1);
    await page.locator("#assistant-pane-focus").click();
    await page.keyboard.type("still talking");
    await expect.poll(() => binary).toBeGreaterThan(0);
  }
  await page.screenshot({ path: info.outputPath(`qa30-${failure.replace(" ", "-")}.png`), fullPage: true });
  // A cold error may use the cached focus identity only after fresh sessions verify it.
  await page.reload();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(view.locator(".focus-header")).toContainText("focus unavailable");
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeEnabled();
  if (desktop) {
    await expect(page.locator("#assistant-pane")).toBeHidden();
    await view.getByRole("button", { name: "Talk to assistant" }).click();
    await expect(terminal).toHaveClass(/hydrated/);
  } else {
    await expect(page.locator(".view.swiping")).toHaveCount(0);
    await view.getByRole("button", { name: "Talk to assistant" }).click();
    await expect(page.locator("#assistant-terminal-header")).toBeVisible();
    await page.locator("#assistant-terminal-focus").click();
  }
  await view.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).not.toContainText("offline");
  await expect(page.locator("#assistant-setting-error")).toHaveText(message);
  await expect(page.locator("#assistant-setting-toggle")).toBeDisabled();
  failed = false;
  await page.locator("#assistant-setting-open").click();
  await expect(view.locator(".focus-header")).not.toContainText("focus unavailable");
  await expect(view.getByRole("textbox", { name: "Add an intention" })).toBeEnabled();
});

test("QA-30: a remote focus home keeps its terminal on the owning machine after store failure and reload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "remote pane routing");
  const origin = "https://focus-home.example.ts.net";
  const id = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
  const json = (body: unknown) => ({ json: body, headers: { "Access-Control-Allow-Origin": "*" } });
  let failed = false;
  let remoteReads = 0;
  const sockets: string[] = [];
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [{ hostname: "focus-home.example.ts.net", tailnetNodeId: "n-home", origin, online: true }] })));
  await page.route(`${origin}/api/machine`, route => route.fulfill(json({
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-home", installationId: id, displayName: "focus home", origin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  })));
  await page.route(`${origin}/api/sessions`, async route => {
    const response = await route.fetch({ url: `${server.baseUrl}/api/sessions` });
    await route.fulfill({ response, ...json(await response.json()) });
  });
  await page.route(url => url.origin === server.baseUrl && url.pathname === "/api/focus", async route => {
    if (failed) return route.fulfill({ status: 503, json: { error: "remote focus store unreadable" } });
    const response = await route.fetch(); const body = await response.json();
    body.local = false; body.home = id;
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.origin === origin && url.pathname === "/api/focus", async route => {
    if (failed) return route.fulfill({ status: 503, ...json({ error: "remote focus store unreadable" }) });
    const response = await route.fetch({ url: `${server.baseUrl}/api/focus` }); const body = await response.json();
    body.local = true; body.home = id; body.installationId = id;
    body.document.nudge.text = `remote focus read ${++remoteReads}`;
    await route.fulfill({ response, ...json(body) });
  });
  // Keep the external peer socket at its transport boundary; no remote service is contacted.
  await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws/pty**`, ws => { sockets.push(ws.url()); });
  page.on("websocket", ws => { if (ws.url().includes("/ws/pty") && new URL(ws.url()).host === new URL(server.baseUrl).host) sockets.push(ws.url()); });
  await page.goto(server.baseUrl);
  // Initial focus can answer before discovery verifies the home. Refresh from
  // that observed ready state instead of racing the next five-second poll.
  await expect(page.locator(`.machine-group[data-machine="n-home:${id}"]`).first()).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#dashboard-focus .focus-nudge")).toHaveText(/^remote focus read /);
  const opened = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === "/api/focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await (await opened).finished();
  // The socket may mount from the previous projection before the open-refresh
  // finishes. Observe that refresh's rendered document before failing the store.
  await expect(page.locator("#assistant-content .focus-nudge")).toHaveText(`remote focus read ${remoteReads}`);
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect.poll(() => sockets.length).toBeGreaterThan(0);
  expect(new URL(sockets[0]!).origin).toBe(origin.replace("https:", "wss:"));
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#assistant-content .focus-header")).toContainText("focus unavailable");
  await expect(page.locator("#assistant-pane-empty")).toBeHidden();
  expect(sockets).toHaveLength(1);
  await page.reload();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect.poll(() => sockets.length).toBe(2);
  expect(new URL(sockets[1]!).origin).toBe(origin.replace("https:", "wss:"));
  await expect(page.locator("#assistant-content .focus-header")).toContainText("focus unavailable");
});

for (const change of ["removed", "replaced", "broker unavailable"] as const) test(`QA-30: store failure does not trust a ${change} assistant target`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "pane target identity guard");
  let failed = false;
  let changed = false;
  await page.route(url => url.pathname === "/api/focus", route => failed ? route.fulfill({ status: 503, json: { error: "focus store unreadable" } }) : route.continue());
  await page.route("**/api/sessions", async route => {
    if (changed && change === "broker unavailable") return route.fulfill({ status: 503, json: { error: "broker unavailable" } });
    const response = await route.fetch(); const body = await response.json();
    if (changed && change === "removed") body.sessions = body.sessions.filter((s: { name: string }) => s.name !== "assistant");
    if (changed && change === "replaced") body.sessions.find((s: { name: string }) => s.name === "assistant").identity.wolfpackSessionId = "mock:replacement-assistant";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await (await opened).finished();
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#assistant-content .focus-header")).toContainText("focus unavailable");
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  changed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#assistant-pane-empty")).toBeVisible();
  await expect(page.locator("#assistant-pane-empty")).not.toContainText("offline");
  await expect(page.locator("#assistant-pty canvas")).toHaveCount(0);
  await expect(page.locator("#assistant-pane-focus")).toBeHidden();
  await expect(page.locator("#assistant-content").getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
});

test("QA-14: self-offline keeps last known next rows, disabled, then recovers", async ({ page, context }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next")).toContainText("prompt-project asks a question");
  await expandFocusCard(view.locator(".focus-next > li").first());
  const summaries = await view.locator(".focus-next .focus-card > summary").allTextContents();
  await context.setOffline(true);
  await expect(view).toContainText("offline · read-only", { timeout: 15_000 });
  await expect(view.locator(".focus-header")).not.toContainText("sessions unavailable");
  await expect(page.locator("#focus-status")).toHaveText(""); // The header already explains the outage, not a bare fetch error.
  expect(await view.locator(".focus-next .focus-card > summary").allTextContents()).toEqual(summaries);
  for (const action of await view.locator(".focus-next button, .focus-chips [data-focus-session], .focus-done button").all()) await expect(action).toBeDisabled();
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
  await context.setOffline(false);
  await expect(view).not.toContainText("offline · read-only", { timeout: 15_000 });
  await expect(view.locator(".focus-next [data-focus-session]").first()).toBeEnabled();
});
