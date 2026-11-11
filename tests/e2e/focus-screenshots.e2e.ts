import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { v3, withContext } from "./focus-context-fixture";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test("needs-you state header opens the assistant terminal while the tile opens the view", async ({ page }) => {
  await page.setViewportSize({ width: Math.min(page.viewportSize()!.width, 1279), height: 900 });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.state = "needs-input";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  // the dashboard block carries the same amber "needs you · answer ›" control, straight to the terminal
  await expect(page.locator("#dashboard-focus .focus-header").getByRole("button", { name: /needs you · answer/ })).toBeVisible();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-view")).toBeVisible();
  await page.locator("#assistant-content .focus-header").getByRole("button", { name: /needs you · answer/ }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
});

test("focus screenshot and layout evidence", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: desktop ? 900 : 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toContainText("Ship the focus assistant today");
  await expect(block.getByRole("button", { name: /prompt-project/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  const screenshots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `focus-dashboard-${desktop ? 1440 : 390}.png`), fullPage: true });
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-view")).toBeVisible();
  await expect(page.locator("#assistant-view")).toContainText("1 of 3 done");
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, `focus-assistant-${desktop ? 1440 : 390}.png`), fullPage: true });
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator(desktop ? "#assistant-pane" : "#assistant-terminal-header")).toBeVisible();
  await expect(page.locator(desktop ? "#assistant-pane canvas" : "#desktop-terminal-container canvas").first()).toBeVisible();
  if (desktop) {
    await expect(page.locator("#sidebar-assistant")).toBeVisible();
    const measures = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector)!;
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
      };
      return { sidebar: box("#desktop-sidebar"), controls: box("#sidebar-session-controls"), filter: box("#sidebar-session-filter"), tile: box("#sidebar-assistant") };
    });
    writeFileSync(join(screenshots, "focus-layout-measurements.json"), JSON.stringify(measures, null, 2));
    // The navigation-only assistant launcher leads the sidebar controls.
    expect(measures.filter.y).toBeGreaterThanOrEqual(measures.tile.y + measures.tile.height);
    expect(Math.round(measures.tile.width)).toBe(Math.round(measures.filter.width));
    expect(measures.tile.height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).include("#sidebar-session-controls").include("#assistant-pane").analyze()).violations).toEqual([]);
  }
  await page.screenshot({ path: join(screenshots, `focus-terminal-${desktop ? 1440 : 390}.png`), fullPage: true });
});

test("QA layout: fixed disclosure/action columns, full-width bodies, shared controls and phone targets", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: desktop ? 900 : 844 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions.push({ id: "one-chip", title: "one linked session", createdAt: new Date().toISOString(), done: false, sessions: ["mock:test-project"] });
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const permission = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    permission.runtimeState.inputKind = "permission";
    const session = body.sessions.find((s: { name: string }) => s.name === "another-project");
    // QA-33: a reviewed finish no longer ranks. Keep this geometry fixture actionable.
    session.runtimeState = { ...session.runtimeState, state: "done", changedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), unseen: true, stoppedSequence: 5, acknowledgedSequence: 0, authority: "program", stale: false };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  if (!desktop) {
    await expect.poll(async () => {
      const box = await block.getByRole("button", { name: "Open assistant", exact: true }).boundingBox();
      return box?.height ?? 0;
    }, { message: "QA-8 dashboard assistant target" }).toBeGreaterThanOrEqual(44);
  }
  const row = block.locator(".focus-next > li").first();
  await row.locator("summary").click();
  const edges = await row.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { body: el.querySelector(".focus-card-body")!.getBoundingClientRect().right, right: rect.right - parseFloat(getComputedStyle(el).paddingRight) };
  });
  expect.soft(Math.abs(edges.body - edges.right), "QA-9 opened body fills the row inset").toBeLessThanOrEqual(1);
  const shots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `qa-layout-dashboard-open-${width}.png`), fullPage: true });
  await row.locator("summary").click();
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-today > li")).toHaveCount(3);
  const aligned = (values: number[]) => Math.max(...values) - Math.min(...values);
  const today = await view.locator(".focus-today > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(today), "QA-6 today chevrons share a column with 0, 1 and 2 chips").toBeLessThanOrEqual(1);
  const chips = await view.locator(".focus-today > li > .focus-chips:not(:empty)").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(chips), "QA-6 chip groups share a right edge").toBeLessThanOrEqual(1);
  await expect(view.getByRole("button", { name: "approve prompt-project permission", exact: true })).toHaveText("approve ›");
  const actions = await view.locator(".focus-next > li > .focus-action").evaluateAll(els => els.map(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const box = el.getBoundingClientRect();
    return { width: box.width, right: box.right, textLeft: range.getBoundingClientRect().left, left: box.left };
  }));
  expect.soft(aligned(actions.map(a => a.width)), "one fixed action width, including approve").toBeLessThanOrEqual(1);
  expect.soft(aligned(actions.map(a => a.right)), "action chevrons share an edge").toBeLessThanOrEqual(1);
  for (const action of actions) expect.soft(action.textLeft, "longest verb fits its column").toBeGreaterThanOrEqual(action.left);
  const next = await view.locator(".focus-next > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(next), "QA-7 open and start share a disclosure column").toBeLessThanOrEqual(1);
  expect.soft(aligned([...today, ...next]), "N1 next and today share one disclosure column").toBeLessThanOrEqual(1);
  if (!desktop) {
    const targets = view.locator("details:not(.focus-card) > summary, .focus-chips button, .focus-done button").filter({ visible: true });
    expect(await targets.count()).toBeGreaterThanOrEqual(5);
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      const hitHeight = await target.evaluate(el => {
        const after = getComputedStyle(el, "::after");
        return Math.max(el.getBoundingClientRect().height, after.content !== "none" ? parseFloat(after.height) || 0 : 0);
      });
      expect.soft(hitHeight, `QA-8 ${await target.textContent()} hit height`).toBeGreaterThanOrEqual(44);
      if (await target.evaluate(el => !!el.closest(".focus-chips"))) expect.soft(box.height, "SF2 phone chip stays a pill").toBeLessThanOrEqual(32);
      expect.soft(box.width, `QA-8 ${await target.textContent()} width`).toBeGreaterThanOrEqual(44);
    }
  }
  if (desktop) {
    const heights = await view.locator(".focus-today > li, .focus-next > li").evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
    for (const height of heights) expect.soft(height, "desktop compact rows stay 44px plus hairline").toBeLessThanOrEqual(45);
  }
  await page.screenshot({ path: join(shots, `qa-layout-assistant-${width}.png`), fullPage: true });
  // Opening one intention must not move its disclosure, and its body may span the chip column.
  await view.locator(".focus-today summary .focus-title").first().click();
  const openToday = await view.locator(".focus-today > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(openToday), "QA-6 open and closed today disclosures align").toBeLessThanOrEqual(1);
  await view.locator(".focus-today summary .focus-title").first().click();
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  if (desktop) {
    const surfaces = await page.evaluate(() => ["#sidebar-session-filter .seg", "#sidebar-assistant"].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { radius: style.borderRadius, padding: style.padding };
    }));
    expect.soft(surfaces[1], "QA-16 filter and launcher share padding and radius tokens").toEqual(surfaces[0]);
    const insets = await page.evaluate(() => {
      const button = document.querySelector("#sidebar-session-filter .seg button")!;
      const range = document.createRange();
      range.selectNodeContents(button.firstChild!);
      const outer = getComputedStyle(document.querySelector("#sidebar-session-filter .seg")!);
      return { label: range.getBoundingClientRect().left, next: document.querySelector("#sidebar-assistant i")!.getBoundingClientRect().left,
        outer: parseFloat(outer.borderRadius), inner: parseFloat(getComputedStyle(button).borderRadius), padding: parseFloat(outer.paddingLeft) };
    });
    expect.soft(Math.abs(insets.label - insets.next), "N2 card label inset matches filter").toBeLessThanOrEqual(1);
    expect.soft(insets.outer, "N2 concentric filter shell").toBe(insets.inner + insets.padding);
  }
  if (desktop) await page.getByRole("button", { name: "Hide assistant terminal", exact: true }).click();
  else await page.locator("#assistant-terminal-header").getByRole("button", { name: "Focus", exact: true }).click();
  await view.getByRole("button", { name: "Assistant settings" }).click();
  const form = page.locator("#assistant-timing");
  const save = (await form.getByRole("button", { name: "Save timing", exact: true }).boundingBox())!;
  const formBox = (await form.boundingBox())!;
  if (desktop) expect.soft(save.width, "QA-3 timing secondary button is content width").toBeLessThan(formBox.width / 2);
  else expect.soft(Math.abs(save.width - formBox.width)).toBeLessThanOrEqual(1);
});

test("R-N1: compact chips keep attention first and hide the least urgent sessions", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: 900 });
  const linked = [{ name: "i", state: "idle" }, { name: "f", state: "failed" }, { name: "w", state: "working" },
    { name: "n", state: "needs-input" }, { name: "x", state: "working" }, { name: "r", state: "idle" }];
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions.push(...linked.map(({ name, state }) => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}` },
      runtimeState: { ...template.runtimeState, state, authority: "program", stale: false },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [{ id: "priority", title: "Attention-ordered chips", done: false, createdAt: new Date().toISOString(), sessions: linked.map(s => `mock:${s.name}`) }];
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const row = page.locator("#assistant-content .focus-today > li");
  const chips = row.locator(":scope > .focus-chips");
  await expect(chips.locator("[data-focus-session]")).toHaveText(["f", "n", "w", "x", "i", "r"]);
  const visible = await chips.locator("[data-focus-session]").filter({ visible: true }).allTextContents();
  expect(visible).toEqual(["f", "n", "w", "x", "i", "r"].slice(0, visible.length));
  if (!desktop) expect(visible).toHaveLength(6);
  const more = chips.getByRole("button", { name: /^\d+ more sessions:/ });
  if (desktop && await more.isVisible()) await more.click();
  else await row.locator("summary .focus-title").click();
  // Only the compact presentation is sorted; expanded details retain the original link order.
  await expect(row.locator(".focus-card-body [data-focus-session]")).toHaveText(linked.map(s => s.name));
});

test("S1: long session chips stay inside their column; six chips keep a compact desktop row", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const longName = `agent-${"x".repeat(70)}`;
  const shortNames = ["agent-1", "agent-2", "agent-3", "test-project", "agent-5", "agent-6"];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions = body.sessions.filter((s: { name: string }) => s.name !== "test-project");
    body.sessions.push(...[longName, ...shortNames].map(name => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}` },
      runtimeState: { ...template.runtimeState, state: "working", authority: "program", stale: false },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [["long-chip", "A long session name", [longName]], ["many-chips", "Six linked sessions", shortNames]].map(([id, title, names]) => ({
      id, title, createdAt: new Date().toISOString(), done: false, sessions: (names as string[]).map(name => `mock:${name}`),
    }));
    await route.fulfill({ response, json: body });
  });
  const shots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(shots, { recursive: true });
  for (const width of desktop ? [1024, 1280, 1440] : [390]) {
    await page.setViewportSize({ width, height: desktop ? 900 : 844 });
    await page.goto(server.baseUrl);
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
    const today = page.locator("#assistant-content .focus-today");
    await expect(today.locator("li")).toHaveCount(2);
    const measurements = await today.locator("li").evaluateAll(rows => rows.map(row => {
      const chips = row.querySelector(":scope > .focus-chips")!.getBoundingClientRect();
      const summary = row.querySelector("summary")!.getBoundingClientRect();
      const title = row.querySelector("summary .focus-title")!.getBoundingClientRect();
      const buttons = [...row.querySelectorAll(":scope > .focus-chips button")].filter(el => el.getBoundingClientRect().width > 0);
      return { height: row.getBoundingClientRect().height, left: chips.left, right: chips.right, summaryRight: summary.right, titleRight: title.right,
        buttons: buttons.map(el => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height, hitHeight: Math.max(rect.height, parseFloat(getComputedStyle(el, "::after").height) || 0), sameLine: rect.top < summary.bottom && rect.bottom > summary.top,
            truncated: !!el.querySelector(".focus-chip-name") && el.querySelector(".focus-chip-name")!.scrollWidth > el.querySelector(".focus-chip-name")!.clientWidth };
        }),
        sessions: buttons.filter(el => el.hasAttribute("data-focus-session")).length };
    }));
    if (desktop) for (const chip of measurements[1]!.buttons) expect.soft(chip.truncated, "short chips are shown only if they fit without losing their identifying suffix").toBe(false);
    for (const row of measurements) {
      if (desktop) expect.soft(row.height, `${width}: one desktop chip line`).toBeLessThanOrEqual(45);
      expect.soft(row.sessions, `${width}: visible sessions never exceed linked sessions`).toBeLessThanOrEqual(6);
      for (const button of row.buttons) {
        if (!desktop) {
          expect.soft(button.hitHeight, "phone chip hit target").toBeGreaterThanOrEqual(44);
          expect.soft(button.height, "SF2 phone chip visual height").toBeLessThanOrEqual(32);
        }
        expect.soft(button.left, `${width}: chip contained, never overlaps disclosure/title`).toBeGreaterThanOrEqual(Math.max(row.left, button.sameLine ? row.titleRight : row.left) - 1);
        expect.soft(button.right, `${width}: chip right edge contained`).toBeLessThanOrEqual(row.right + 1);
      }
    }
    const long = today.getByRole("button", { name: longName, exact: true });
    await expect.soft(long).toHaveAttribute("title", longName, { timeout: 1_000 });
    expect.soft(await long.evaluate(el => {
      const label = el.querySelector(".focus-chip-name");
      return label ? getComputedStyle(label).textOverflow : null;
    })).toBe("ellipsis");
    if (desktop) {
      const row = today.locator("li").last();
      const visible = await row.locator(":scope > .focus-chips [data-focus-session]:visible").allTextContents();
      expect(visible).toEqual(shortNames.slice(0, visible.length));
      await expect(row.getByRole("button", { name: `${6 - visible.length} more sessions: ${shortNames.slice(visible.length).join(", ")}`, exact: true })).toBeVisible();
    } else {
      await expect(today.locator(".focus-chip-more").filter({ visible: true })).toHaveCount(0);
      await expect(today.locator("li").last().getByRole("button")).toHaveCount(6);
      await today.scrollIntoViewIfNeeded();
    }
    expect((await new AxeBuilder({ page }).include("#assistant-content .focus-today").analyze()).violations).toEqual([]);
    await page.screenshot({ path: join(shots, `corrections-chips-${width}.png`), fullPage: true });
  }
  const today = page.locator("#assistant-content .focus-today");
  if (desktop) await today.getByRole("button", { name: /^\d+ more sessions:/ }).click();
  else await today.locator("li").last().locator("summary").click();
  const expanded = today.locator("li").filter({ hasText: "Six linked sessions" });
  await expect(expanded.locator("details")).toHaveAttribute("open", "");
  for (const name of shortNames) await expect(expanded.locator(".focus-card-body")).toContainText(name);
  await expanded.screenshot({ path: join(shots, `corrections3-sessions-${desktop ? 1440 : 390}.png`) });
  const fourth = expanded.locator(".focus-card-body").getByRole("button", { name: shortNames[3], exact: true });
  await expect(fourth).toBeVisible({ timeout: 1_000 });
  const socket = page.waitForEvent("websocket", { predicate: ws => new URL(ws.url()).searchParams.get("session") === shortNames[3] });
  await fourth.click();
  await socket;
  await expect(page.locator("#terminal-view")).toBeVisible();
});

test("SF2: the phone pill has a 44px hit area beyond its visual box", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone extended chip target");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const chip = page.locator("#assistant-content .focus-today > li > .focus-chips").getByRole("button", { name: "another-project", exact: true });
  // Trial click scrolls and retries a node replaced by a startup refresh, without activating it.
  await chip.click({ trial: true });
  const box = (await chip.boundingBox())!;
  expect.soft(box.height).toBeLessThanOrEqual(32);
  await page.touchscreen.tap(box.x + box.width / 2, box.y - 7);
  await expect(page.locator("#terminal-view")).toBeVisible({ timeout: 1_000 });
});

for (const change of ["resize", "linked sessions"] as const) test(`R1: revealed chips refit after ${change} while their card was open`, async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop fitting after a hidden interval");
  await page.setViewportSize({ width: change === "resize" ? 390 : 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let names = Array.from({ length: 6 }, (_, index) => `agent-${index + 1}`);
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // No poll response may mask the reveal bug by causing an unrelated render.
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route("**/api/sessions", async route => {
    if (hold) await gate;
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions.push(...names.map(name => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}` },
      runtimeState: { ...template.runtimeState, state: "working", authority: "program", stale: false },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (hold) await gate;
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [{ id: "refit", title: "Refit linked sessions", createdAt: new Date().toISOString(), done: false, sessions: names.map(name => `mock:${name}`) }];
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto(server.baseUrl);
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
    const row = page.locator("#assistant-content .focus-today > li");
    const summary = row.locator("summary");
    if (change === "resize") await expect(row.getByRole("button")).toHaveCount(6);
    else await expect(row.getByRole("button", { name: /^\d+ more sessions:/ })).toBeVisible();
    await summary.locator(".focus-title").click();
    await expect(row.locator("details")).toHaveAttribute("open", "");
    await expect(row.locator(":scope > .focus-chips")).toBeHidden();
    if (change === "resize") await page.setViewportSize({ width: 1024, height: 900 });
    else {
      names = Array.from({ length: 6 }, (_, index) => `reviewer-worker-${index + 1}`);
      await expect(row.locator(".focus-card-body")).toContainText("reviewer-worker-6", { timeout: 15_000 });
      await expect(row.locator("details")).toHaveAttribute("open", "");
    }
    hold = true;
    await summary.locator(".focus-title").click();
    await expect(row.locator("details")).not.toHaveAttribute("open", /.*/);
    const labels = row.locator("[data-focus-session]:visible .focus-chip-name");
    const visible = await labels.allTextContents();
    expect(visible.length).toBeGreaterThan(0);
    expect(visible).toEqual(names.slice(0, visible.length));
    await expect.soft(row.locator(".focus-chip-more")).toHaveText(`+${6 - visible.length}`, { timeout: 1_000 });
    const readable = await labels.evaluateAll(els => els.every(el => el.scrollWidth <= el.clientWidth));
    expect.soft(readable, "revealed short names keep their identifying suffixes").toBe(true);
    await expect(summary).toBeFocused();
    const shots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `corrections2-reveal-${change.replace(" ", "-")}.png`), fullPage: true });
  } finally { release(); }
});

test("focus card captures: a session card open with and without the agent's context, an intention card", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: desktop ? 900 : 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  let contextDocument: unknown = v3;
  await withContext(page, () => contextDocument);
  const screenshots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect(row.locator(".focus-context")).toBeVisible();
  await expect(row.locator(".focus-context")).toContainText("Ship the focus cards round");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(screenshots, `focus-card-context-dashboard-${width}.png`), fullPage: true });
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  // open state is per card, shared by the dashboard block and the page: the card opened above is open here too
  await expect(view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("details.focus-card")).toHaveAttribute("open", "");
  await view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" }).locator(".focus-card > summary .focus-title").click();
  await expect(view.locator(".focus-context")).toBeVisible();
  await expect(view.locator(".focus-context")).toContainText("Wire the context block");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(screenshots, `focus-card-context-assistant-${width}.png`), fullPage: true });
  // the same session with no document: the card shows only what the dashboard already knows
  contextDocument = null;
  await expect(view.locator(".focus-context")).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: join(screenshots, `focus-card-plain-assistant-${width}.png`), fullPage: true });
});
