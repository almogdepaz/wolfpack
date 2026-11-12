import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
import { remoteFocusHome } from "./focus-home-fixture";
import { FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.addInitScript(key => localStorage.setItem(key, "1"), FOCUS_MOBILE_EXPANDED_KEY); });
const terminal = (page: Page) => page.locator(page.viewportSize()!.width >= 1280 ? "#assistant-pane" : "#assistant-terminal-header");
async function task(page: Page, title = "prepare release", project?: string) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const exists = current.document.intentions.some((i: { id: string }) => i.id === "plan-task");
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [
    ...(exists ? [{ type: "drop", id: "plan-task" }] : []),
    { type: "add", intention: { id: "plan-task", title, ...(project ? { project, machine: "workstation" } : {}) } },
    { type: "next", author: "assistant", rows: [{ ref: { intentionId: "plan-task" }, verdict: "needs-you", reason: "Choose the first step with the assistant" }] },
  ] } })).ok()).toBe(true);
}
async function open(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
const plan = (page: Page, title = "prepare release") => page.locator("#assistant-content .focus-today").getByRole("button", { name: `Plan “${title}” with the assistant`, exact: true });

for (const outcome of ["delivered", "pasted_not_submitted", "submitted"]) test(`today plan prefills assistant without Enter then expands terminal: ${outcome}`, async ({ page }) => {
  await task(page, "prepare release", "/work/release");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sends: unknown[] = [], creates: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/create")) creates.push(request.url()); });
  await page.route("**/api/session-control/send", async route => {
    sends.push(route.request().postDataJSON()); await gate; await route.fulfill({ json: { outcome } });
  });
  try {
    await open(page);
    await expect(page.locator("#assistant-pane")).toBeHidden();
    await expect(plan(page)).toHaveText("plan ›");
    await plan(page).click();
    await expect.poll(() => sends.length).toBe(1);
    await expect(page.locator("#assistant-pane")).toBeHidden();
    release();
    await expect(terminal(page)).toBeVisible();
    expect(sends).toEqual([{ session: "assistant", text: "plan “prepare release” (task plan-task, project /work/release, on workstation): ", noEnter: true }]);
    expect(creates).toEqual([]);
    await expect(page.locator("#projects-view")).not.toHaveClass(/visible/);
  } finally { release(); }
});

test("next-row plan keeps the id when truncating a 500-character title", async ({ page }) => {
  const title = "x".repeat(500);
  await task(page, title);
  let text = "";
  await page.route("**/api/session-control/send", async route => { text = route.request().postDataJSON().text; await route.fulfill({ json: { outcome: "delivered" } }); });
  await open(page);
  const row = page.locator("#assistant-content .focus-next > li").filter({ hasText: title });
  await expandFocusCard(row);
  await row.getByRole("button", { name: `Plan “${title}” with the assistant`, exact: true }).click();
  await expect.poll(() => text).toContain("(task plan-task");
  expect(text).toMatch(/^plan “x+…” \(task plan-task.*\): $/);
  expect(text.length).toBeLessThan(500);
  expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  await expect(terminal(page)).toBeVisible();
});

test("prefill strips terminal controls and line breaks from task context", async ({ page }) => {
  const title = "release\nnext\u001b[31m\u202estep";
  await task(page, title, "/work/\tproject\u0007");
  let text = "";
  await page.route("**/api/session-control/send", async route => { text = route.request().postDataJSON().text; await route.fulfill({ json: { outcome: "delivered" } }); });
  await open(page);
  await page.locator('#assistant-content [data-focus-plan="plan-task"]').click();
  await expect.poll(() => text).toBe("plan “release next [31m step” (task plan-task, project /work/ project, on workstation): ");
  expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

for (const state of ["needs-input", "no-target"]) test(`plan is disabled for ${state}`, async ({ page }) => {
  await task(page);
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    if (state === "needs-input") body.assistant.state = state;
    else { delete body.assistant.session; delete body.assistant.sessionId; }
    await route.fulfill({ response, json: body });
  });
  let sends = 0;
  page.on("request", request => { if (request.url().endsWith("/api/session-control/send")) sends++; });
  await open(page);
  await expect(plan(page)).toBeDisabled();
  if (state === "needs-input") await expect(plan(page)).toHaveAttribute("title", /dialog/);
  const row = page.locator("#assistant-content .focus-next > li").filter({ hasText: "prepare release" });
  await expandFocusCard(row);
  await expect(row.getByRole("button", { name: "Plan “prepare release” with the assistant", exact: true })).toBeDisabled();
  expect(sends).toBe(0);
});

test("send errors are visible and do not expand the terminal", async ({ page }) => {
  await task(page);
  await page.route("**/api/session-control/send", route => route.fulfill({ status: 503, json: { error: "assistant input unavailable" } }));
  await open(page); await plan(page).click();
  await expect(page.locator("#focus-status")).toHaveText("assistant input unavailable");
  await expect(page.locator("#assistant-pane")).toBeHidden();
});

for (const outcome of ["not_delivered", "unverified"]) test(`plan reports unsuccessful delivery: ${outcome}`, async ({ page }) => {
  await task(page);
  await page.route("**/api/session-control/send", route => route.fulfill({ json: { outcome } }));
  await open(page); await plan(page).click();
  await expect(page.locator("#focus-status")).toContainText(outcome === "not_delivered" ? "not delivered" : "not confirmed");
  await expect(page.locator("#assistant-pane")).toBeHidden();
});

test("a dialog that appears after the rendered plan button prevents the paste", async ({ page }) => {
  await task(page);
  let dialog = false;
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    if (dialog) body.assistant.state = "needs-input";
    await route.fulfill({ response, json: body });
  });
  let sends = 0;
  page.on("request", request => { if (request.url().endsWith("/api/session-control/send")) sends++; });
  await open(page); await expect(plan(page)).toBeEnabled();
  dialog = true;
  await plan(page).click();
  await expect(plan(page)).toBeDisabled();
  expect(sends).toBe(0);
});

test("a remote home plan sends to the assistant machine, not the intention's machine", async ({ page }) => {
  await task(page, "prepare release", "/work/release");
  const home = await remoteFocusHome(page, server);
  const sends: string[] = [];
  await page.route("**/api/session-control/send", async route => { sends.push(route.request().url()); expect(route.request().postDataJSON().session).toBe("assistant"); await route.fulfill({ json: { outcome: "delivered" }, headers: { "Access-Control-Allow-Origin": "*" } }); });
  try {
    await page.goto(server.baseUrl); await home.ready();
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await plan(page).click();
    await expect.poll(() => sends).toEqual([`${home.origin}/api/session-control/send`]);
    await expect(terminal(page)).toBeVisible();
  } finally { home.release(); }
});
