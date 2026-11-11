import { expandFocusCard } from "./focus-card-helpers";
import { test, expect } from "@playwright/test";
import { FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";
// Row-content checks use an explicitly expanded dashboard; disclosure defaults have their own coverage.
test.beforeEach(async ({ page }) => { await page.addInitScript(key => localStorage.setItem(key, "1"), FOCUS_MOBILE_EXPANDED_KEY); });
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const kind of ["question", "permission"] as const) test(`phone row time: ${kind} stays whole without a trailing timestamp`, async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: 900 });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.runtimeState = { ...session.runtimeState, state: "needs-input", inputKind: kind, changedAt: new Date(Date.now() - 720_000).toISOString() };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  for (const surface of ["dashboard-focus", "assistant-content"]) {
    if (surface === "assistant-content") await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await expect(page.locator(".view.swiping")).toHaveCount(0);
    const row = page.locator(`#${surface} .focus-next li`).filter({ hasText: "prompt-project" });
    const title = row.locator("summary .focus-title");
    await expect(title).toHaveText(kind === "question" ? "prompt-project asks a question" : "prompt-project needs approval");
    await expect(row.locator(".focus-meta")).toContainText("12m");
    await expect(title.locator("small")).toHaveCount(0);
    const size = await title.evaluate(el => {
      const range = document.createRange(); range.selectNode(el.firstChild!);
      return { available: el.clientWidth, label: range.getBoundingClientRect().width };
    });
    expect(size.available, `${surface}: the kind word is readable`).toBeGreaterThanOrEqual(size.label);
    await page.screenshot({ path: info.outputPath(`row-time-${surface}-${desktop ? 1440 : 390}-${kind}.png`), fullPage: true });
  }
});

for (const [state, inputKind, label, verb] of [
  ["needs-input", "permission", "permission", "approve"],
  ["needs-input", "question", "question", "answer"],
  ["needs-input", "auth", "auth", "log in"],
  ["needs-input", undefined, "needs you", "open"],
  ["failed", "permission", "failed", "retry"],
  ["done", "question", "stopped", "review"],
  ["idle", undefined, "stopped", "review"],
] as const) test(`row truth: ${state}/${inputKind ?? "unknown"} says ${label} and ${verb}`, async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.runtimeState = { ...s.runtimeState, state, inputKind, unseen: true, stoppedSequence: 5,
      acknowledgedSequence: 0, changedAt: new Date(Date.now() - 720_000).toISOString() };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  const tag = state === "needs-input" ? inputKind === "permission" ? "approve" : inputKind === "auth" ? "log in" : inputKind === "question" ? "answer" : "needs you" : state === "done" ? "done" : label;
  await expect(row.locator("summary .focus-tag")).toHaveText(tag);
  await expect(row.locator("summary .focus-meta")).toContainText("prompt-project · 12m");
  await expandFocusCard(row);
  await expect(row.getByRole("button", { name: "Open prompt-project", exact: true })).toHaveText("open ›");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const action = page.locator("#assistant-content").getByRole("button", { name: "Open prompt-project", exact: true });
  await expect(action).toHaveText("open ›");
  await expect(page.locator("#sidebar-assistant .assistant-tile-next")).toContainText(`prompt-project ${label}`);
  // All verbs navigate through the existing session opener, including retry (not a restart).
  const socket = page.waitForEvent("websocket", { predicate: ws => new URL(ws.url()).searchParams.get("session") === "prompt-project" });
  await action.click();
  await socket;
  await expect(page.locator("#terminal-view")).toBeVisible();
});

test("row context: next and remote targets stay visible; compact today context yields to chips", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").identity.projectPath = "/work/focus-ui";
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions.find((i: { id: string }) => i.id === "leak").project = "/work/broker";
    body.document.intentions.find((i: { id: string }) => i.id === "leak").machine = "remote-box";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("summary .focus-meta")).toContainText("focus-ui");
  await expect(block.locator(".focus-next li").filter({ hasText: "fix broker leak" }).locator("summary .focus-meta")).toHaveText("broker · remote-box");
  for (const context of await block.locator("summary .focus-for").all()) await expect(context).toBeVisible();
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-today li").filter({ hasText: "fix broker leak" }).locator("summary .focus-for")).toHaveText("broker · remote-box");
  const shipToday = view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" });
  await expect(shipToday.locator("summary .focus-for")).toContainText("focus-ui");
  if (info.project.name === "desktop") {
    // Context may use spare room, but never displaces the linked-session chips.
    await expect(shipToday.getByRole("button", { name: "prompt-project", exact: true })).toBeVisible();
    expect(await shipToday.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  } else await expect(shipToday.locator("summary .focus-for")).toBeVisible();
  await expect(view.locator(".focus-today li").filter({ hasText: "fix broker leak" }).locator("summary .focus-for")).toBeVisible();
  for (const context of await view.locator(".focus-next summary .focus-for").all()) await expect(context).toBeVisible();
  const linkedContext = view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("summary .focus-meta");
  await expect(linkedContext).toContainText("focus-ui");
  expect(await linkedContext.evaluate(el => el.scrollWidth <= el.clientWidth), "intention and project fit without hiding the context").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 390) {
    for (const summary of await view.locator(".focus-next summary, .focus-today summary").all()) {
      const context = summary.locator(".focus-for");
      if (await context.count()) expect(await context.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(await summary.locator(".focus-title").evaluate(el => el.getBoundingClientRect().top));
    }
  }
  if (process.env.WOLFPACK_FOCUS_SHOTS) {
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-context-${width}.png`), fullPage: true });
  }
});

test("row context: local starts omit redundant machine names when only the assistant runs", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  const localName = (await (await page.request.get(`${server.baseUrl}/api/info`)).json()).name;
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => s.name === "assistant");
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [
      { id: "local-start", title: "Local start", project: "/work/broker", machine: localName, createdAt: new Date().toISOString(), done: false },
      { id: "remote-start", title: "Remote start", project: "/work/remote", machine: "remote-box", createdAt: new Date().toISOString(), done: false },
    ];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next li").filter({ hasText: "Local start" }).locator("summary .focus-meta")).toHaveText("broker");
  await expect(block.locator(".focus-next li").filter({ hasText: "Remote start" }).locator("summary .focus-meta")).toHaveText("remote · remote-box");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  for (const list of [".focus-next", ".focus-today"]) {
    const meta = list === ".focus-next" ? ".focus-meta" : ".focus-for";
    await expect(view.locator(`${list} li`).filter({ hasText: "Local start" }).locator(`summary ${meta}`)).toHaveText("broker");
    await expect(view.locator(`${list} li`).filter({ hasText: "Remote start" }).locator(`summary ${meta}`)).toHaveText("remote · remote-box");
  }
  if (process.env.WOLFPACK_FOCUS_SHOTS) {
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `row-local-only-assistant-${width}.png`), fullPage: true });
  }
});

test("QA-25: phone next count is reachable with one show-more action, including rows beyond five", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone next disclosure");
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => s.name === "assistant");
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = Array.from({ length: 7 }, (_, i) => ({ id: `goal-${i + 1}`, title: `Goal ${i + 1}`, createdAt: new Date().toISOString() }));
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.getByRole("heading", { name: "next 7", exact: true })).toBeVisible();
  await expect(view.locator(".focus-next > li:visible")).toHaveCount(3);
  await page.screenshot({ path: info.outputPath("phone-next-more.png"), animations: "disabled" });
  await view.getByRole("button", { name: "show 4 more", exact: true }).click();
  await expect(view.locator(".focus-next > li:visible")).toHaveCount(7);
  await expect(view.locator(".focus-next .focus-title")).toHaveText(Array.from({ length: 7 }, (_, i) => `start “Goal ${i + 1}”`));
  await expect(view.locator(".focus-next > li").nth(3).locator("summary")).toBeFocused();
  await expandFocusCard(view.locator(".focus-next > li").last());
  await view.getByRole("button", { name: "start “Goal 7”", exact: true }).click();
  await expect(page.locator("#projects-view")).toBeVisible();
});

test("counts: validated needs-you population and uncapped next totals agree", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    body.sessions.push(...Array.from({ length: 8 }, (_, index) => ({ ...template, name: `count-${index}`,
      identity: { ...template.identity, wolfpackSessionId: `mock:count-${index}` },
      runtimeState: { ...template.runtimeState, state: index === 7 ? "failed" : "needs-input", stale: index === 6,
        freshness: index === 6 ? "stale" : "fresh", changedAt: index === 6 ? "2020-01-01T00:00:00Z" : new Date().toISOString() },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="need"] .n')).toHaveAttribute("data-count", "7");
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="fail"] .n')).toHaveAttribute("data-count", "1");
  await expect(page.locator("#assistant-content .focus-next")).not.toContainText("count-6");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("8 next:");
  await expect(page.locator("#dashboard-focus > .focus-dashboard-body > small").last()).toContainText("8 next");
  await expect(page.locator("#dashboard-focus .focus-next > li")).toHaveCount(3);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content > h2").first()).toHaveText("next 8");
  await expect(page.locator("#assistant-content .focus-next > li")).toHaveCount(5);
});

test("counts: sessions claimed only by done intentions fall through to unlinked next", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const prompt = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    prompt.identity.projectPath = "/repo";
    body.sessions.push(...["blocked-explicit", "blocked-unlinked"].map(name => ({ ...prompt, name,
      identity: { ...prompt.identity, wolfpackSessionId: `mock:${name}`, projectPath: "/other" } })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [
      { id: "done-project", title: "completed project", project: "/repo", done: true, createdAt: new Date().toISOString() },
      { id: "done-explicit", title: "completed explicit", sessions: ["mock:blocked-explicit"], done: true, createdAt: new Date().toISOString() },
    ];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="need"] .n')).toHaveAttribute("data-count", "3");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("3 next:");
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  await expect(block.locator(":scope > .focus-dashboard-body > small").last()).toContainText("3 next");
  for (const name of ["prompt-project", "blocked-explicit", "blocked-unlinked"]) {
    const row = block.locator(".focus-next > li").filter({ hasText: name });
    await expandFocusCard(row);
    await expect(row.getByRole("button", { name: `Open ${name}`, exact: true })).toBeVisible();
  }
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-next > li")).toHaveCount(3);
  await expect(page.locator("#assistant-content > h2").first()).toHaveText("next 3");
});

test("many stops: twelve unseen episodes remain capped without an hours cutoff", async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const names = Array.from({ length: 12 }, (_, i) => `review-${String(i + 1).padStart(2, "0")}`);
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...names.map((name, i) => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}`, projectPath: `/work/research-${i % 3 + 1}` },
      runtimeState: { ...template.runtimeState, state: i % 2 ? "idle" : "done", unseen: true, stoppedSequence: 5,
        acknowledgedSequence: 0, stoppedAt: new Date(Date.now() - (i + 2) * 864e5).toISOString(),
        changedAt: new Date(Date.now() - (12 - i) * 60_000).toISOString() },
    }))];
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [{ id: "stops", title: "Review stopped research", createdAt: new Date().toISOString(), done: false, sessions: names.map(n => `mock:${n}`) }];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  await expect(block.locator(".focus-next .focus-title")).toHaveText(names.slice(0, 3).map((name, i) => `${name} ${i % 2 ? "stopped" : "is done"}`));
  await expect(block.locator(".focus-next .focus-meta")).toHaveText(names.slice(0, 3).map((name, i) => `${name} · ${i + 2}d · research-${i % 3 + 1}`));
  const shots = process.env.WOLFPACK_FOCUS_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `old-stops-dashboard-${width}.png`), fullPage: true });
  }
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next > li")).toHaveCount(5);
  await expect(view.locator(".focus-next > li:visible")).toHaveCount(width === 390 ? 3 : 5);
  await expect(view.locator(".focus-next .focus-title")).toHaveText(names.slice(0, 5).map((name, i) => `${name} ${i % 2 ? "stopped" : "is done"}`));
  expect(await view.locator(".focus-next summary .focus-meta span").first().evaluate(el => el.getClientRects().length), "project name stays readable in metadata").toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: join(shots, `old-stops-assistant-${width}.png`), fullPage: true });
});
