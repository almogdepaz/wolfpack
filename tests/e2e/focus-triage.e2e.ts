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
      s.lastLine = "Step 2 done. Continue with step 3?";
      s.runtimeState = { ...s.runtimeState, state: s.name === "another-project" ? "idle" : done ? "done" : "needs-input", inputKind: done ? undefined : "question", changedAt: episode, stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0, stale: false, freshness: "fresh" };
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
  await expect(block.getByRole("textbox", { name: "reply to prompt-project", exact: true })).toHaveValue(draft);
  await expect(block.locator(".focus-next")).not.toContainText("another-project");
  await expect(block).toContainText(/ordered (now|\d+m) ago/);
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("2 next:");
  await expect(page.locator("#sidebar-assistant .assistant-tile-next")).toContainText("The approved plan is ready to continue");
  expect(sends).toEqual([]);
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(":scope > h2").first()).toHaveText("next 2");
  const row = view.locator(".focus-next > li").first();
  await expect(row.locator("summary")).not.toContainText("The approved plan is ready to continue");
  await expect(row.locator(".focus-draft")).toContainText("assistant: The approved plan is ready to continue");
  await expect(row.locator(".focus-draft small").first()).toHaveText("last line from prompt-project: Step 2 done. Continue with step 3?");
  const send = row.locator(".focus-draft").getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  await expect(send).toHaveText("send suggestion to prompt-project ›");
  await expect(send).toHaveAttribute("aria-describedby", `${await row.locator(".focus-draft textarea").getAttribute("id")}-description`);
  await expect(send).toHaveAccessibleDescription(draft);
  expect(await block.locator(".focus-draft textarea").first().getAttribute("id")).toMatch(/^fd-d-\d+$/);
  await expect(row.locator(".focus-draft textarea")).toHaveAttribute("id", /^fd-p-\d+$/);
  await expect(row.locator(":scope > .focus-action")).toHaveText("open ›");
  await expect(row.locator(":scope > .focus-action")).toHaveAccessibleName("Open prompt-project");
  await expect(row.locator("summary .focus-for")).toContainText("focus");
  await expect(row.locator(".focus-draft > div")).toContainText("will be typed into prompt-project");
  await expect(row.locator(".focus-draft > div")).toHaveCSS("font-size", "13px");
  await expect(row.locator(".focus-draft > div")).toContainText("and submitted:");
  await expect(row.locator(".focus-draft textarea")).toHaveValue(draft);
  expect(await row.locator(".focus-draft textarea").inputValue(), "the visible draft preserves exact spacing").toBe(draft);
  await expect(view.locator(".focus-next")).toContainText("new · by rules");
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.locator("#assistant-view").evaluate(el => { el.scrollTop = 0; });
  expect((await new AxeBuilder({ page }).include("#assistant-content").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`triage-${width}-suggest-quiet.png`), fullPage: true });
  await row.locator("summary").click();
  await expect(row.locator(".focus-card-body")).toContainText("Ship the focus assistant");
  await row.getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  await expect(row.locator('[role="status"]')).toContainText("✓ sent to prompt-project");
  await expect(row.locator(".focus-draft > div")).toContainText("typed into prompt-project");
  await expect(row.locator(".focus-draft > div")).toHaveCSS("font-size", "13px");
  await expect(row.locator(".focus-draft")).not.toContainText("will be typed");
  await expect(send).toHaveCount(0);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ session: "mock:prompt-project", text: draft });
  await write(page, [{ type: "note", text: "force a fresh focus revision" }]);
  await page.waitForResponse(response => new URL(response.url()).pathname === "/api/focus" && response.request().method() === "GET");
  await expect(row).toContainText("sent to prompt-project");
  await expect(send).toHaveCount(0);
  expect(sends).toHaveLength(1);
});

for (const lastLine of ["", "Earlier output: " + "x".repeat(170) + " <terminal> Continue?"]) test(`suggest captions handle ${lastLine ? "long untrusted" : "empty"} last lines and long target names`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const name = "continuation-worker-with-a-very-long-name";
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.name = name; session.lastLine = lastLine;
    session.runtimeState = { ...session.runtimeState, state: "needs-input", changedAt: episode, stoppedAt: episode };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ has: page.locator(".focus-draft textarea") });
  const send = row.getByRole("button", { name: `Send suggestion to ${name}`, exact: true });
  await expect(send).toHaveText(`send suggestion to ${name} ›`);
  await expect(send).toHaveAccessibleDescription(draft);
  const bounds = await row.locator(".focus-draft").boundingBox();
  const buttonBounds = await send.boundingBox();
  expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  expect(buttonBounds!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await expect(row.locator(".focus-draft")).toContainText(`will be typed into ${name} ·`);
  if (lastLine) {
    await expect(row.locator(".focus-draft q")).toHaveText("…" + lastLine.slice(-160));
    await expect(row.locator(".focus-draft q > *")).toHaveCount(0);
    await row.locator("summary").click();
    await expect(row.locator(".focus-card-body code")).toHaveText(lastLine);
  } else await expect(row.locator(".focus-draft q")).toHaveCount(0);
  await row.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

for (const outcome of ["not_delivered", "pasted_not_submitted"] as const) test(`suggest sending and ${outcome} feedback stay beside the exact draft`, async ({ page }) => {
  await seed(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  await page.route("**/api/session-control/send", async route => {
    sends++; await held;
    await route.fulfill({ json: { outcome } });
  });
  await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ has: page.locator(".focus-draft textarea") });
  const send = row.getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  try {
    await send.click();
    await expect(send).toBeDisabled();
    await expect(send).toHaveText("sending…");
    await expect(row.locator('[role="status"]')).toHaveCount(0);
    release();
    await expect(row.locator('[role="status"]')).toHaveText(outcome === "not_delivered" ? "not sent · try again" : "pasted, not submitted · check the session");
    await expect(row.locator(".focus-draft textarea")).toHaveValue(draft);
    await expect(row.locator(".focus-draft > div")).toContainText(outcome === "not_delivered" ? "will be typed into prompt-project" : "typed into prompt-project");
    if (outcome !== "not_delivered") await expect(row.locator(".focus-draft > div")).not.toContainText("will be typed");
    await expect(row.getByRole("button", { name: "Open prompt-project", exact: true })).toBeEnabled();
    if (outcome === "not_delivered") {
      await expect(send).toBeEnabled();
      await expect(send).toHaveText("send suggestion to prompt-project ›");
      await expect(send).toHaveAccessibleDescription(draft);
    } else await expect(send).toHaveCount(0);
    expect(sends).toBe(1);
  } finally { release(); }
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

test("editable reply stays shared across hosts and live renders without replacing the focused field", async ({ page }, info) => {
  await seed(page);
  await page.goto(server.baseUrl);
  const field = (host: string) => page.locator(host).locator('textarea[aria-label="reply to prompt-project"]');
  const dashboard = field("#dashboard-focus");
  await expect(dashboard).toHaveValue(draft);
  await expect(dashboard).toHaveAccessibleName("reply to prompt-project");
  await expect(dashboard).toHaveAttribute("maxlength", "2000");
  await expect(page.locator("#dashboard-focus").getByRole("button", { name: "reset", exact: true })).toHaveCount(0);
  const edited = "Review my edited reply; keep the scope unchanged.";
  await dashboard.fill(edited);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const reply = field("#assistant-content");
  await expect(reply).toHaveValue(edited);
  await reply.focus();
  await reply.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(7, 15, "backward"));
  const element = await reply.elementHandle();
  const saved = await write(page, [{ type: "nudge", text: "A live update must not discard your reply.", author: "assistant" }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!).revision)).toBe(saved.revision);
  await expect(reply).toBeFocused();
  expect(await element!.evaluate(el => el === document.activeElement)).toBe(true);
  expect(await reply.evaluate(el => { const field = el as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd, field.selectionDirection]; })).toEqual([7, 15, "backward"]);
  await expect(reply).toHaveValue(edited);
  await expect(dashboard).toHaveValue(edited);
  await expect(page.locator("#assistant-content").getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toHaveAccessibleDescription(edited);
  expect(saved.revision).toBeGreaterThan(0);
  await reply.evaluate(el => (el as HTMLTextAreaElement).blur());
  await expect(page.locator("#assistant-content .focus-nudge")).toHaveText("A live update must not discard your reply.");
  const reset = page.locator("#assistant-content").getByRole("button", { name: "reset", exact: true });
  await expect(reset).toBeVisible();
  await page.screenshot({ path: join(process.env.HOME!, ".cache/focus-edit-collapse-shots", `suggest-edited-${info.project.name === "desktop" ? "desktop" : "390"}.png`), fullPage: true });
  expect((await new AxeBuilder({ page }).include("#assistant-content").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reset.click();
  await expect(reply).toHaveValue(draft);
  await expect(dashboard).toHaveValue(draft);
  await expect(reset).toHaveCount(0);
});

for (const host of ["dashboard-focus", "assistant-content"] as const) for (const input of ["keyboard", "pointer"] as const) test(`deferred panel flushes after ${input} blur in ${host}`, async ({ page }) => {
  await seed(page);
  const sends: { text: string }[] = [];
  await page.route("**/api/session-control/send", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome: "submitted" } });
  });
  await page.goto(server.baseUrl);
  if (host === "assistant-content") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const panel = page.locator(`#${host}`);
  const reply = panel.getByRole("textbox", { name: "reply to prompt-project", exact: true });
  const send = panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  const text = "edited before leaving the editor";
  const message = `Deferred ${input} blur ${host}`;
  await reply.fill(text);
  const saved = await write(page, [{ type: "nudge", text: message, author: "assistant" }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!).revision)).toBe(saved.revision);
  await expect(reply).toBeFocused();
  await expect(panel.locator(".focus-nudge")).not.toHaveText(message);
  if (input === "keyboard") {
    await reply.press("Tab");
    await expect(panel.locator(".focus-nudge")).toHaveText(message, { timeout: 1500 });
    await expect(send).toBeFocused();
    await expect(reply).toHaveValue(text);
    await page.keyboard.press("Enter");
  } else {
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport({ ratio: .9 });
    const box = (await send.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // A held pointer must still activate the clicked control after blur settles.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.up();
  }
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].text).toBe(text);
  await expect(panel.locator(".focus-nudge")).toHaveText(message);
});

for (const host of ["dashboard-focus", "assistant-content"] as const) test(`native IME replacement stays attached in ${host} through input and live refresh`, async ({ page }, info) => {
  await seed(page);
  await page.goto(server.baseUrl);
  if (host === "assistant-content") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const panel = page.locator(`#${host}`);
  const reply = panel.getByRole("textbox", { name: "reply to prompt-project", exact: true });
  await expect(reply).toHaveValue(draft);
  const cdp = await page.context().newCDPSession(page);
  const stages: { host: string; text: string; value: string }[] = [];
  try {
    // Same native replacement sequence as the reviewer's standalone control probe.
    await page.evaluate(() => {
      const control = document.createElement("textarea"); control.id = "ime-control";
      control.style.cssText = "position:fixed;top:0;left:0;z-index:9999";
      document.body.append(control);
    });
    const control = page.locator("#ime-control");
    await control.focus();
    for (const text of ["n", "ni", "你"]) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send("Input.insertText", { text: "你" });
    await expect(control).toHaveValue("你");
    await control.evaluate(el => el.remove());
    await reply.fill("");
    await expect(panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeDisabled();
    const editor = await reply.elementHandle();
    await editor!.evaluate(el => {
      el.dataset.imeBlurs = "0"; el.dataset.imeDetaches = "0";
      el.addEventListener("blur", () => { el.dataset.imeBlurs = String(Number(el.dataset.imeBlurs) + 1); });
      const observer = new MutationObserver(records => {
        for (const record of records) for (const removed of record.removedNodes) if (removed === el || removed.contains(el)) el.dataset.imeDetaches = String(Number(el.dataset.imeDetaches) + 1);
      });
      observer.observe(el.closest("#dashboard-focus, #assistant-content")!, { childList: true, subtree: true });
      el.addEventListener("blur", () => observer.disconnect(), { once: true });
    });
    for (const text of ["n", "ni", "你"]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      stages.push({ host, text, value: await reply.inputValue() });
      if (text === "ni") {
        const saved = await write(page, [{ type: "nudge", text: `Live IME update for ${host}.`, author: "assistant" }]);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!).revision)).toBe(saved.revision);
      }
    }
    await cdp.send("Input.insertText", { text: "你" });
    writeFileSync(info.outputPath(`ime-${host}.json`), JSON.stringify({ stages, final: await reply.inputValue(), blurs: await editor!.getAttribute("data-ime-blurs"), detaches: await editor!.getAttribute("data-ime-detaches") }, null, 2));
    await expect(reply).toHaveValue("你");
    expect(stages.map(stage => stage.value)).toEqual(["n", "ni", "你"]);
    expect(await editor!.getAttribute("data-ime-blurs")).toBe("0");
    expect(await editor!.getAttribute("data-ime-detaches")).toBe("0");
    await expect(reply).toBeFocused();
    await expect(panel.getByRole("button", { name: "reset", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toHaveAccessibleDescription("你");
    await reply.evaluate(el => (el as HTMLTextAreaElement).blur());
    await expect(panel.locator(".focus-nudge")).toHaveText(`Live IME update for ${host}.`);
    await expect(reply).toHaveValue("你");
  } finally { await cdp.detach(); }
});

test("editable reply prevents Enter, flattens pasted newlines, caps at 2000 and disables blank sends", async ({ page }) => {
  await seed(page);
  const sends: unknown[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/session-control/send") sends.push(request.postDataJSON()); });
  await page.goto(server.baseUrl);
  const panel = page.locator("#dashboard-focus");
  const reply = panel.getByRole("textbox", { name: "reply to prompt-project", exact: true });
  const send = panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  for (const blank of ["", "   "]) { await reply.fill(blank); await expect(send).toBeDisabled(); }
  await reply.fill("go ");
  await reply.press("End");
  await reply.press("Enter");
  await expect(reply).toHaveValue("go ");
  await reply.evaluate(el => {
    const data = new DataTransfer(); data.setData("text/plain", "one\r\ntwo\nthree");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(reply).toHaveValue("go one two three");
  await reply.fill("x".repeat(1999));
  await reply.press("End");
  await reply.pressSequentially("abc");
  await expect(reply).toHaveValue("x".repeat(1999) + "a");
  await reply.fill("");
  await reply.evaluate(el => {
    const data = new DataTransfer(); data.setData("text/plain", "y".repeat(2500));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(reply).toHaveValue("y".repeat(2000));
  expect(sends).toEqual([]);
});

for (const outcome of ["submitted", "unverified", "pasted_not_submitted", "not_delivered"] as const) test(`edited reply sends the user's text and retains the original duplicate fence: ${outcome}`, async ({ page }) => {
  await seed(page);
  const sends: { text: string }[] = [];
  const edited = outcome === "submitted" ? "/review notes  exactly as typed" : "!review notes  exactly as typed";
  await page.route("**/api/session-control/send", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome } });
  });
  await page.goto(server.baseUrl);
  const panel = page.locator("#dashboard-focus");
  const reply = panel.getByRole("textbox", { name: "reply to prompt-project", exact: true });
  const send = panel.getByRole("button", { name: "Send suggestion to prompt-project", exact: true });
  await reply.fill(edited);
  await send.click();
  await expect(panel.locator(".focus-draft [role=status]")).toBeVisible();
  expect(sends).toHaveLength(1);
  expect(sends[0].text).toBe(edited);
  await expect(reply).toHaveValue(edited);
  if (outcome === "not_delivered") {
    await expect(send).toBeEnabled();
    await expect(reply).toBeEditable();
    await reply.fill("a different retry");
    await send.click();
    await expect.poll(() => sends.length).toBe(2);
    expect(sends[1].text).toBe("a different retry");
    return;
  }
  await expect(reply).not.toBeEditable();
  await expect(panel.locator(".focus-draft > div")).toContainText("typed into prompt-project");
  await expect(panel.locator(".focus-draft > div")).not.toContainText("will be typed");
  await expect(send).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "reset", exact: true })).toHaveCount(0);
  const receipts = await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-send-receipts-v1")!));
  expect(receipts).toHaveLength(1);
  expect(JSON.parse(receipts[0][0])[2]).toBe(draft);
  expect(receipts[0][1].text).toBe(edited);
  await page.reload();
  await expect(reply).toHaveValue(edited);
  await expect(reply).not.toBeEditable();
  await expect(send).toHaveCount(0);
  expect(sends).toHaveLength(1);
});

test("a draft is dropped when its original action leaves the next rows", async ({ page }) => {
  await seed(page);
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const rows = current.document.next.rows;
  await page.goto(server.baseUrl);
  const reply = page.locator("#dashboard-focus").getByRole("textbox", { name: "reply to prompt-project", exact: true });
  await reply.fill("an obsolete draft");
  await write(page, [{ type: "next", author: "assistant", rows: [] }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reply).not.toBeEditable();
  await expect(page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toBeDisabled();
  await reply.evaluate(el => (el as HTMLTextAreaElement).blur());
  await expect(reply).toHaveCount(0);
  await write(page, [{ type: "next", author: "assistant", rows }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reply).toHaveValue(draft);
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
  await expect(row.locator(".focus-draft [data-focus-next]")).toBeDisabled();
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
    s.runtimeState = { ...s.runtimeState, state: phase === "stopped" ? "idle" : "needs-input", changedAt: phase === "stopped" ? episode : "2026-11-09T12:01:00Z", stoppedAt: episode, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 };
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
  await expect.poll(() => sent).toMatchObject({ session: "mock:prompt-project", text: draft });
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
  await expect(button).toHaveCount(0);
  await write(page, [{ type: "next", author: "assistant", rows: [{ ref: { sessionId: "mock:prompt-project", machine }, stoppedAt: episode.replace("Z", "+00:00"), verdict: "suggest", reason: "Same draft, new formatting", suggestion: draft }] }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#dashboard-focus")).toContainText("Same draft, new formatting");
  await expect(button).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#dashboard-focus .focus-draft textarea")).toHaveValue(draft);
  await expect(button).toHaveCount(0);
  await expect(page.locator("#dashboard-focus")).toContainText(outcome === "submitted" ? "sent to prompt-project" : "delivery unconfirmed");
  expect(sends).toBe(1);
});

test("focus-only lastLine stripping preserves the normal session preview", async ({ page }) => {
  await seed(page);
  const preview = "👩‍💻 ✔️ review\u202e now\u200b";
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.lastLine = preview;
    s.runtimeState = { ...s.runtimeState, state: "needs-input", changedAt: episode, stoppedAt: episode };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card').filter({ has: page.locator('.card-open[data-session="prompt-project"]') }).first().locator('.card-preview')).toHaveText(preview);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "The approved plan" });
  await row.locator("summary").click();
  const line = row.locator(".focus-card-body code");
  await expect(line).toHaveText("👩💻 ✔ review now");
});

test("an uncertain user send stays visible and cannot be tapped again", async ({ page }) => {
  await seed(page);
  await page.route("**/api/session-control/send", route => route.fulfill({ json: { ok: true, outcome: "unverified", delivery: "unverified", observedMs: 1 } }));
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true }).click();
  await expect(page.locator("#dashboard-focus")).toContainText("delivery unconfirmed · check the session");
  await expect(page.locator("#dashboard-focus").getByRole("button", { name: "Send suggestion to prompt-project", exact: true })).toHaveCount(0);
});
