import { test, expect, type Page } from "@playwright/test";
import { expandFocusCard } from "./focus-card-helpers";
import { startTestServer, type TestServer } from "./helpers";
import { FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let local: TestServer, remote: TestServer;
const origin = "https://race-peer.example.ts.net";
const peerId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
declare global { interface Window { focusPreflightReceiptWrites?: number } }
test.beforeEach(async () => { local = await startTestServer({ focusAssistant: true }); remote = await startTestServer({ focusAssistant: true }); });
test.afterEach(async ({ page }) => { await page.close(); await local?.close(); await remote?.close(); });
async function open(page: Page) {
  // These ownership checks exercise body controls, not the phone disclosure default.
  await page.addInitScript(key => localStorage.setItem(key, "1"), FOCUS_MOBILE_EXPANDED_KEY);
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "race-peer.example.ts.net", tailnetNodeId: "n-race", origin, online: true }] } }));
  // Only peer transport/identity is adapted; both stores and settings handlers are real fixtures.
  await page.route(`${origin}/api/**`, async route => {
    const url = new URL(route.request().url());
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (url.pathname === "/api/machine") return route.fulfill({ headers, json: {
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-race", installationId: peerId, displayName: "Race peer", origin },
      wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    } });
    if (!["/api/focus", "/api/settings", "/api/sessions"].includes(url.pathname)) return route.abort();
    const response = await route.fetch({ url: remote.baseUrl + url.pathname + url.search });
    if (url.pathname === "/api/focus" && response.ok()) return route.fulfill({ response, headers, json: { ...await response.json(), installationId: peerId, home: peerId, assistant: { enabled: false, state: "off", queued: 0 } } });
    await route.fulfill({ response, headers });
  });
  await page.goto(local.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  for (const row of await page.locator("#assistant-content .focus-next > li").all()) await expandFocusCard(row);
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Home machine", exact: true }).locator(`option[value='${peerId}']`)).toHaveText("Race peer");
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function moveFromAnotherClient() {
  expect((await fetch(local.baseUrl + "/api/focus/assistant", { method: "POST", body: JSON.stringify({ enabled: false }) })).status).toBe(200);
  expect((await fetch(local.baseUrl + "/api/focus/home", { method: "POST", body: JSON.stringify({ home: peerId }) })).status).toBe(200);
}

async function seedTriage(page: Page, done = false) {
  const episode = "2026-11-10T12:00:00.000Z";
  const current = await (await fetch(local.baseUrl + "/api/focus")).json();
  expect((await fetch(local.baseUrl + "/api/focus", { method: "POST", body: JSON.stringify({ expectedRevision: current.revision, ops: [
    { type: "add", intention: { id: "triage-goal", title: "Original home goal", sessions: ["mock:prompt-project"] } },
    { type: "next", author: "assistant", rows: [{ ref: { machine: current.installationId, sessionId: "mock:prompt-project" }, stoppedAt: episode, verdict: "suggest", reason: "The original home's recommendation", ...(done ? { doneIntention: "triage-goal" } : { suggestion: "Keep the approved scope." }) }] },
  ] }) })).status).toBe(200);
  await page.route(`${local.baseUrl}/api/sessions`, async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.runtimeState = { ...session.runtimeState, state: done ? "done" : "needs-input", inputKind: done ? undefined : "question", changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 };
    await route.fulfill({ response, json: body });
  });
}

for (const failure of ["aborted during move", "same-owner 503"] as const) test(`TM-R1: ${failure} preflight refuses send and every receipt write`, async ({ page }) => {
  await page.addInitScript(() => {
    window.focusPreflightReceiptWrites = 0;
    const put = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "wolfpack-focus-send-receipts-v1") window.focusPreflightReceiptWrites!++;
      return put.call(this, key, value);
    };
  });
  await seedTriage(page); await open(page); await page.locator("#assistant-setting-open").click();
  const identity = await (await fetch(local.baseUrl + "/api/focus")).json();
  const receiptBefore = await page.evaluate(() => localStorage.getItem("wolfpack-focus-send-receipts-v1"));
  const gate = latch(), arrived = latch();
  const sends: unknown[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().postDataJSON()); await route.fulfill({ json: { outcome: "submitted" } }); });
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    arrived.release(); await gate.promise;
    if (failure === "aborted during move") return route.abort();
    return route.fulfill({ status: 503, json: { home: identity.home, installationId: identity.installationId, local: true, error: "fixture focus store unreadable" } });
  });
  try {
    await page.locator("#assistant-content").getByRole("button", { name: "Send to prompt-project", exact: true }).click();
    await arrived.promise;
    if (failure === "aborted during move") await moveFromAnotherClient();
    gate.release();
    await expect(page.locator("#assistant-content .focus-header")).toContainText("read-only");
    // refresh renders while run() is busy; the enabled picker proves its finally
    // completed, so neither a late send nor a receipt mutation escapes this check.
    await expect(page.locator("#assistant-setting-home-select")).toBeEnabled();
    expect(sends).toEqual([]);
    expect(await page.evaluate(() => window.focusPreflightReceiptWrites)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("wolfpack-focus-send-receipts-v1"))).toBe(receiptBefore);
  } finally { gate.release(); }
});

test("merge: a suggestion tapped after the home moved is refused before send or receipt persistence", async ({ page }) => {
  await seedTriage(page); await open(page); await page.locator("#assistant-setting-open").click();
  const sends: string[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().url()); await route.fulfill({ json: { outcome: "submitted" } }); });
  const send = page.locator("#assistant-content").getByRole("button", { name: "Send to prompt-project", exact: true });
  await expect(send).toBeEnabled();
  await moveFromAnotherClient();
  await send.click();
  await expect.poll(async () => sends.length > 0 || await page.locator("#app-dialog").isVisible()).toBe(true);
  expect(sends).toEqual([]);
  await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-send-receipts-v1") || "[]"))).toEqual([]);
});

test("merge: a held pre-tap poll cannot authorize a suggestion after the home moved", async ({ page }) => {
  await seedTriage(page); await open(page); await page.locator("#assistant-setting-open").click();
  const gate = latch(), arrived = latch();
  let held = false;
  const sends: string[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().url()); await route.fulfill({ json: { outcome: "submitted" } }); });
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true; const response = await route.fetch(); arrived.release(); await gate.promise; await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await arrived.promise;
    await moveFromAnotherClient();
    await page.locator("#assistant-content").getByRole("button", { name: "Send to prompt-project", exact: true }).click();
    gate.release();
    await expect.poll(async () => sends.length > 0 || await page.locator("#app-dialog").isVisible()).toBe(true);
    expect(sends).toEqual([]);
    await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-send-receipts-v1") || "[]"))).toEqual([]);
  } finally { gate.release(); }
});

test("merge: a late suggestion delivery keeps its original receipt without replaying onto the new home", async ({ page }) => {
  await seedTriage(page); await open(page); await page.locator("#assistant-setting-open").click();
  const gate = latch(), arrived = latch();
  const sends: { url: string; body: unknown }[] = [];
  await page.route("**/api/session-control/send", async route => {
    sends.push({ url: route.request().url(), body: route.request().postDataJSON() }); arrived.release();
    await gate.promise; await route.fulfill({ json: { outcome: "submitted" } });
  });
  try {
    await page.locator("#assistant-content").getByRole("button", { name: "Send to prompt-project", exact: true }).click();
    await arrived.promise;
    await moveFromAnotherClient();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#assistant-setting-home")).toContainText("Race peer");
    gate.release();
    await expect(page.locator("#app-dialog")).toContainText("the home changed; check the previous session's delivery before retrying");
    expect(sends).toEqual([{ url: local.baseUrl + "/api/session-control/send", body: { session: "mock:prompt-project", text: "Keep the approved scope.", ensureSubmitted: true } }]);
    const receipts = await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-send-receipts-v1") || "[]"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0][1]).toMatchObject({ state: "sent", label: "sent to prompt-project" });
  } finally { gate.release(); }
});

test("merge: a done verdict cannot write or retry onto the new home", async ({ page }) => {
  await seedTriage(page, true); await open(page); await page.locator("#assistant-setting-open").click();
  const beforeA = (await (await fetch(local.baseUrl + "/api/focus")).json()).document;
  const beforeB = (await (await fetch(remote.baseUrl + "/api/focus")).json()).document;
  const done = page.locator("#assistant-content").getByRole("button", { name: "Mark done: Original home goal", exact: true });
  await expect(done).toBeEnabled();
  await moveFromAnotherClient();
  await done.click();
  await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
  const before = JSON.parse(readFileSync(join(local.home, ".wolfpack/assistant/focus.json"), "utf8"));
  expect(before).toEqual(beforeA);
  expect((await (await fetch(remote.baseUrl + "/api/focus")).json()).document).toEqual(beforeB);
});

test("S1: rejected A write is never replayed on B, and explicitly reports not saved", async ({ page }) => {
  await open(page);
  await page.locator("#assistant-setting-open").click();
  const gate = latch(), arrived = latch();
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    arrived.release(); await gate.promise; await route.continue();
  });
  const title = "keep this action on the original home";
  const peerWrites: string[] = [];
  page.on("request", req => { if (req.url() === origin + "/api/focus" && req.method() === "POST") peerWrites.push(req.postData()!); });
  try {
    await page.getByRole("textbox", { name: "Add an intention", exact: true }).fill(title);
    await page.locator("#assistant-content").getByRole("button", { name: "Add", exact: true }).click();
    await arrived.promise;
    await moveFromAnotherClient();
    gate.release();
    await expect.soft(page.locator("#app-dialog")).toContainText("not saved — the home changed");
    const doc = (await (await fetch(remote.baseUrl + "/api/focus")).json()).document;
    expect(doc.intentions.some((i: { title: string }) => i.title === title)).toBe(false);
    expect(peerWrites).toEqual([]);
  } finally { gate.release(); }
});

test("S1: an explicit ownership rejection cannot use a held old poll as proof for retry", async ({ page }) => {
  await open(page); await page.locator("#assistant-setting-open").click();
  const gate = latch(), arrived = latch();
  let posts = 0;
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() === "POST") { posts++; return route.continue(); }
    const response = await route.fetch(); arrived.release(); await gate.promise; await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await arrived.promise;
    await moveFromAnotherClient();
    await page.getByRole("textbox", { name: "Add an intention", exact: true }).fill("do not replay an explicit rejection");
    const rejected = page.waitForResponse(r => r.url() === local.baseUrl + "/api/focus" && r.request().method() === "POST");
    await page.locator("#assistant-content").getByRole("button", { name: "Add", exact: true }).click();
    await (await rejected).finished(); gate.release();
    await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
    expect(posts).toBe(1);
  } finally { gate.release(); }
});

test("S1-R1: a late A rejection cannot revoke B timing after B is loaded", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "settings-page background polling is desktop-only");
  const original = (await (await fetch(remote.baseUrl + "/api/settings")).json()).settings.assistant;
  expect((await fetch(remote.baseUrl + "/api/settings", { method: "POST", body: JSON.stringify({ assistant: { ...original, quietMinutes: 99 } }) })).status).toBe(200);
  await open(page); await page.locator("#assistant-setting-open").click();
  const gate = latch(), arrived = latch();
  let posts = 0;
  const peerWrites: string[] = [];
  page.on("request", req => { if (req.url() === origin + "/api/focus" && req.method() === "POST") peerWrites.push(req.postData()!); });
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++; arrived.release(); await gate.promise; await route.continue();
  });
  try {
    await page.getByRole("textbox", { name: "Add an intention", exact: true }).fill("late rejected old-home action");
    await page.locator("#assistant-content").getByRole("button", { name: "Add", exact: true }).click();
    await arrived.promise;
    await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
    const quiet = page.locator('#assistant-timing input[name="quietMinutes"]');
    // Finish the settings-opening A read before requesting the B observation.
    await expect(quiet).toBeEnabled();
    await moveFromAnotherClient();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#assistant-setting-home")).toContainText("Race peer");
    await expect(quiet).toHaveValue("99");
    await expect(quiet).toBeEnabled();
    gate.release();
    await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
    await page.locator("#app-dialog-confirm").click();
    const fresh = page.waitForResponse(r => r.url() === origin + "/api/focus" && r.request().method() === "GET");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await (await fresh).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#assistant-timing-status")).toHaveText("Routine timing on Race peer.");
    await expect(quiet).toHaveValue("99");
    await expect(quiet).toBeEnabled();
    await expect(page.locator("#assistant-timing").getByRole("button", { name: "Save timing", exact: true })).toBeEnabled();
    expect(posts).toBe(1); expect(peerWrites).toEqual([]);
  } finally { gate.release(); }
});

test("S1: late A timing cannot replace or be saved as B timing", async ({ page }) => {
  const gate = latch(), arrived = latch();
  await page.route(`${local.baseUrl}/api/settings`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); arrived.release(); await gate.promise; await route.fulfill({ response });
  });
  const original = (await (await fetch(remote.baseUrl + "/api/settings")).json()).settings.assistant;
  expect((await fetch(remote.baseUrl + "/api/settings", { method: "POST", body: JSON.stringify({ assistant: { ...original, quietMinutes: 99 } }) })).status).toBe(200);
  try {
    await open(page); await arrived.promise;
    await page.locator("#assistant-setting-toggle").click(); await page.locator("#app-dialog-confirm").click();
    await expect(page.locator("#assistant-setting-status")).toHaveText("off");
    await page.getByRole("combobox", { name: "Home machine", exact: true }).selectOption(peerId);
    await page.locator("#app-dialog-confirm").click();
    const quiet = page.locator('#assistant-timing input[name="quietMinutes"]');
    await expect(quiet).toHaveValue("99");
    const delivered = page.waitForResponse(r => r.url() === local.baseUrl + "/api/settings" && r.request().method() === "GET");
    gate.release(); await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect.soft(await quiet.inputValue()).toBe("99");
    await expect(page.locator("#assistant-timing-status")).toHaveText("Routine timing on Race peer.");
    await page.locator("#assistant-timing").getByRole("button", { name: "Save timing", exact: true }).click();
    await expect(page.locator("#assistant-timing-status")).toHaveText("Routine timing saved.");
    expect((await (await fetch(remote.baseUrl + "/api/settings")).json()).settings.assistant.quietMinutes).toBe(99);
  } finally { gate.release(); }
});

test("S1: timing save rejects values loaded before an unobserved home change", async ({ page }) => {
  await open(page);
  await expect(page.locator('#assistant-timing input[name="quietMinutes"]')).toBeEnabled();
  await moveFromAnotherClient();
  const writes: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/settings" && req.method() === "POST") writes.push(req.url()); });
  await page.locator("#assistant-timing").getByRole("button", { name: "Save timing", exact: true }).click();
  await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
  expect(writes).toEqual([]);
});

test("S1: a pending assistant confirmation never disables the new home's assistant", async ({ page }) => {
  await open(page);
  await page.locator("#assistant-setting-toggle").click();
  await moveFromAnotherClient();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const writes: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/focus/assistant") writes.push(req.url()); });
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
  expect(writes).toEqual([]);
  expect((await (await fetch(remote.baseUrl + "/api/focus")).json()).assistant.enabled).toBe(true);
});

test("S1: Mark read from an old day-note dialog cannot acknowledge the new home", async ({ page }) => {
  const date = "2026-11-08";
  mkdirSync(join(local.home, ".wolfpack/assistant/days"), { recursive: true });
  writeFileSync(join(local.home, `.wolfpack/assistant/days/${date}.md`), "# old home\n\n## assistant\nOld review.");
  const before = await (await fetch(local.baseUrl + "/api/focus")).json();
  expect((await fetch(local.baseUrl + "/api/focus", { method: "POST", body: JSON.stringify({ expectedRevision: before.revision, ops: [{ type: "day-summary", summary: { date, done: 0, carried: 0, questions: 0 } }] }) })).status).toBe(200);
  await open(page); await page.locator("#assistant-setting-open").click();
  await page.getByRole("button", { name: `Read day note for ${date}`, exact: true }).click();
  await expect(page.locator("#app-dialog")).toContainText("Old review.");
  await moveFromAnotherClient();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#assistant-setting-home")).toContainText("Race peer");
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#app-dialog")).toContainText("not saved — the home changed");
  expect((await (await fetch(remote.baseUrl + "/api/focus")).json()).document.seenDayNoteAt).toBeUndefined();
});

test("S1: same-home CAS conflict still retries once against the refreshed document", async ({ page }) => {
  await open(page); await page.locator("#assistant-setting-open").click();
  let posts = 0;
  await page.route(`${local.baseUrl}/api/focus`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    if (++posts === 1) {
      const current = await (await fetch(local.baseUrl + "/api/focus")).json();
      expect((await fetch(local.baseUrl + "/api/focus", { method: "POST", body: JSON.stringify({ expectedRevision: current.revision, ops: [{ type: "add", intention: { id: "concurrent", title: "other operator" } }] }) })).status).toBe(200);
    }
    await route.continue();
  });
  await page.getByRole("textbox", { name: "Add an intention", exact: true }).fill("same home retry");
  await page.locator("#assistant-content").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-today")).toContainText("same home retry");
  expect(posts).toBe(2);
  const titles = (await (await fetch(local.baseUrl + "/api/focus")).json()).document.intentions.map((i: { title: string }) => i.title);
  expect(titles).toContain("same home retry"); expect(titles).toContain("other operator");
});
