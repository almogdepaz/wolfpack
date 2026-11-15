import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
async function seed(page: Page, asks = 4, inputKind = "question") {
  await page.addInitScript(() => { localStorage.setItem("wolfpack-sidebar-pinned", "1"); localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1"); });
  const now = new Date().toISOString();
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json(); delete body.routines;
    body.document.intentions = [];
    body.document.next = { updatedAt: now, author: "assistant", rows: Array.from({ length: asks }, (_, i) => (
      { ref: { machine: current.installationId, sessionId: `mock:ask-${i}` }, stoppedAt: now, verdict: "needs-you", reason: i === 0 ? "Approve the smoke test. It contacts a paid endpoint." : `Choose the next step for ask-${i}. Both options are ready.` }
    )) };
    await route.fulfill({ response, json: body });
  });
  const seen = new Set<string>();
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...["done-0", "ask-0", "done-1", "ask-1", "ask-2", "ask-3"].filter(name => name.startsWith("done") || Number(name.slice(4)) < asks).map(name => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}`, projectPath: `/work/${name}` },
      lastLine: name === "ask-0" ? "Opus 5.5 | tokens: 152.3k | ctx: 25% left" : `Finished ${name} safely.`,
      runtimeState: { ...template.runtimeState, state: name.startsWith("done") ? "done" : "needs-input", inputKind, changedAt: now, stoppedAt: now,
        unseen: !seen.has(`mock:${name}`), stoppedSequence: 5, transitionSequence: 5, acknowledgedSequence: seen.has(`mock:${name}`) ? 5 : 0 },
    }))];
    await route.fulfill({ response, json: body });
  });
  return seen;
}
async function capture(page: Page, name: string) {
  const root = process.env.WOLFPACK_FOCUS_SHOTS;
  if (!root) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(root, name + ".png"), fullPage: true });
}

test("settled 390px expanded assistant has no horizontal overflow or offset", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 1); await page.goto(server.baseUrl);
  await expandFocusCard(page.locator("#dashboard-focus .focus-next > li").first());
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const geometry = () => page.evaluate(() => {
    const view = document.getElementById("assistant-view")!;
    const bounds = view.getBoundingClientRect();
    return { swiping: view.classList.contains("swiping"), transform: getComputedStyle(view).transform, left: bounds.left, right: bounds.right,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  const during = await geometry();
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#assistant-content .focus-card").first()).toHaveAttribute("open", "");
  const settled = await geometry();
  writeFileSync(info.outputPath("390-expanded-geometry.json"), JSON.stringify({ during, settled }, null, 2));
  expect(settled.scrollWidth).toBe(settled.clientWidth);
  expect(settled.left).toBe(0);
  expect(settled.right).toBe(390);
  expect(settled.swiping).toBe(false);
});

for (const asks of [0, 1]) test(`390px assistant header keeps the ${asks ? "needs-you" : "nothing-needs-you"} title whole`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, asks); await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const title = page.locator("#assistant-content .focus-count");
  await expect(title).toHaveText(asks ? "1 needs you" : "nothing needs you");
  expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Talk to assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Assistant settings", exact: true })).toBeVisible();
});

test("visual evidence: dashboard and assistant collapsed and expanded", async ({ page }, info) => {
  await seed(page, 1);
  const suffix = info.project.name === "desktop" ? "desktop" : "390";
  await page.setViewportSize({ width: suffix === "desktop" ? 1440 : 390, height: 1000 });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li").first()).toBeVisible();
  await capture(page, `dashboard-${suffix}-collapsed`);
  const ask = block.locator(".focus-next > li").filter({ hasText: "Approve the smoke test." });
  await expandFocusCard(ask);
  await capture(page, `dashboard-${suffix}-expanded`);
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const card = page.locator("#assistant-content .focus-next > li").filter({ hasText: "Approve the smoke test." });
  await expect(card.locator("details.focus-card")).toHaveAttribute("open", "");
  await capture(page, `assistant-${suffix}-expanded`);
  await card.locator("summary").click();
  await capture(page, `assistant-${suffix}-collapsed`);
});

for (const host of ["dashboard", "page"] as const) test(`expanded ${host} puts the editable reply before open and collapsed details`, async ({ page }) => {
  await seed(page); await page.goto(server.baseUrl);
  if (host === "page") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const block = page.locator(host === "page" ? "#assistant-content" : "#dashboard-focus");
  const row = block.locator(".focus-next > li").filter({ hasText: "Choose the next step for ask-1." });
  await expandFocusCard(row);
  await expect(row.locator(".focus-ask")).toHaveCount(0);
  await expect(row.getByText("Choose the next step for ask-1.", { exact: true })).toHaveCount(1);
  const reply = row.getByRole("textbox", { name: "reply to ask-1", exact: true });
  await reply.fill("Use the first option.");
  const send = row.getByRole("button", { name: "Send to ask-1", exact: true });
  await expect(send).toHaveAccessibleDescription("Use the first option.");
  await expect(reply).toHaveAccessibleDescription("message to ask-1 · typed into its terminal and submitted");
  await expect(reply).toBeFocused();
  await expect(send).toBeEnabled();
  expect(await row.evaluate(el => {
    const selectors = [":scope > .focus-card > summary", "textarea", "[data-focus-next][aria-describedby]", "[data-focus-session]", ".focus-context-more"];
    const nodes = selectors.map(selector => el.querySelector(selector));
    return nodes.every((node, i) => !!node && (!i || !!(nodes[i - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
  })).toBe(true);
  const lastLine = row.locator("details.focus-context-more");
  await expect(lastLine).not.toHaveAttribute("open", "");
  await lastLine.locator("summary").click();
  await expect(lastLine).toContainText("Finished ask-1 safely.");
});

test("header, page heading and sidebar agree on attention without duplicate dashboard counts", async ({ page }, info) => {
  await seed(page); await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-header .focus-count")).toHaveText("4 needs you");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toContainText("4 needs you");
  await expect(block.locator(".focus-header")).not.toContainText("ordered");
  await expect(block.locator(".focus-dashboard-body > small")).toHaveCount(0);
  await expect(block).not.toContainText("today");
  if (info.project.name !== "desktop") expect((await block.getByText("why this order", { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-header .focus-count")).toHaveText("4 needs you");
  await view.getByText("why this order", { exact: true }).click();
  await expect(view.locator(":scope > details")).toContainText("ordered just now");
});

for (const [inputKind, tag] of [["question", "decide"], ["permission", "approve"], ["auth", "log in"]] as const) test(`assistant needs-you: ${inputKind} labels the next move as ${tag}`, async ({ page }) => {
  await seed(page, 1, inputKind); await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus .focus-next .focus-tag")).toHaveText(tag);
});

for (const [inputKind, line, headline, tag] of [
  ["question", "Choose bun add or vendoring?", "Choose bun add or vendoring?", "reply"],
  ["permission", "Approve the proposed smoke test?", "Approve the proposed smoke test?", "approve"],
  ["auth", "Log in to the package registry.", "Log in to the package registry.", "log in"],
  ["question", "", "prompt-project asks a question", "reply"],
  ["permission", "Opus 5.5 | tokens: 152.3k | ctx: 25% left", "prompt-project needs approval", "approve"],
] as const) test(`rule headline promotes ${inputKind} prompt or keeps its fallback: ${line || "empty"}`, async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.lastLine = line;
    session.runtimeState = { ...session.runtimeState, state: "needs-input", inputKind };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  for (const host of ["dashboard-focus", "assistant-content"]) {
    if (host === "assistant-content") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    const row = page.locator(`#${host} .focus-next > li`).filter({ hasText: "prompt-project" });
    await expect(row.locator("summary strong")).toHaveText(headline);
    await expect(row.locator("summary .focus-tag")).toHaveText(tag);
    await expect(row.locator("summary q")).toHaveCount(0);
  }
});

test("the assistant page reports today's count only once, in the working footer", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-quiet")).toContainText("today 1 of 3 done");
  expect((await view.textContent())!.match(/1 of 3 done/g)).toHaveLength(1);
  await expect(view.getByRole("heading", { name: "today", exact: true })).toBeVisible();
});

test("duplicate projects and terminal status bars do not add noise", async ({ page }) => {
  await seed(page); await page.goto(server.baseUrl);
  const row = page.locator("#dashboard-focus .focus-next > li").filter({ hasText: "Approve the smoke test." });
  await expect(row.locator("summary [title='/work/ask-0']")).toHaveCount(0);
  await expandFocusCard(row);
  await expect(row.locator("dt").filter({ hasText: /^last line$/ })).toHaveCount(0);
  await expect(row).not.toContainText("tokens: 152.3k");
});

test("done is a compact second tier and does not consume the three full-card slots", async ({ page }) => {
  await seed(page); await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  await expect(block.locator(".focus-finished > li")).toHaveCount(2);
  const row = block.locator(".focus-finished > li").first();
  await expect(row.locator(":scope > .focus-card > summary")).toContainText(/✓ done-\d · \d\d:\d\d ·/);
  await expect.poll(async () => (await row.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(52);
  await expandFocusCard(row);
  await expect(row.getByRole("textbox")).toBeVisible();
  await expect(row.getByRole("button", { name: "mark seen", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: /^Open done-/ })).toBeVisible();
});

for (const host of ["dashboard", "page"] as const) test(`mark all seen on ${host} is sequential and keeps failed done rows`, async ({ page }) => {
  const seen = await seed(page);
  const calls: string[] = [];
  let inFlight = 0, maxFlight = 0;
  let fail = true;
  await page.route("**/api/agent-runtime-state/ack", async route => {
    const body = route.request().postDataJSON();
    calls.push(body.sessionId); inFlight++; maxFlight = Math.max(maxFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (fail && body.sessionId === "mock:done-0") await route.fulfill({ status: 500, json: { error: "ack refused" } });
    else { seen.add(body.sessionId); await route.fulfill({ json: { ok: true, runtimeState: { state: "done", unseen: false, transitionSequence: 5, stoppedSequence: 5, acknowledgedSequence: 5 } } }); }
    inFlight--;
  });
  await page.goto(server.baseUrl);
  if (host === "page") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const block = page.locator(host === "page" ? "#assistant-content" : "#dashboard-focus");
  await block.getByRole("button", { name: "mark all seen", exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(maxFlight).toBe(1);
  await expect(block.locator(".focus-finished > li")).toHaveCount(1);
  await expect(block.locator(".focus-finished")).toContainText("done-0");
  await expect(page.locator(host === "page" ? "#focus-status" : "#dashboard-focus [role=status]")).toContainText("done-0");
  fail = false;
  await block.getByRole("button", { name: "mark all seen", exact: true }).click();
  await expect(block.locator(".focus-finished")).toHaveCount(0);
  expect(calls.filter(id => id === "mock:done-1")).toHaveLength(1);
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
});
