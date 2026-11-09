import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

test("QA-20: chips use remaining title space on render and resize, with an exact overflow count", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const ordered = ["l", ...names.slice(0, -1)];
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    body.sessions.push(...names.map(name => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}` },
      runtimeState: { ...template.runtimeState, state: name === "l" ? "needs-input" : "working", authority: "program", stale: false },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [
      { id: "fit", title: "Ship the assistant", names },
      { id: "long-title", title: "An intention whose full title needs more than the entire available row width and must yield no space to session names", names },
      { id: "all-fit", title: "Done", names: ["a", "l"] },
    ].map(({ id, title, names }) => ({ id, title, done: false, createdAt: new Date().toISOString(), sessions: names.map(name => `mock:${name}`) }));
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: desktop ? 1024 : 390, height: 900 });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const row = page.locator("#assistant-content .focus-today > li").first();
  const chips = row.locator(":scope > .focus-chips");
  const counts: number[] = [];
  for (const width of desktop ? [1024, 1280, 1440, 1279, 1024] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => row.locator("summary .focus-title").textContent()).toContain("Ship the assistant");
    // Wait for the resize render's sizing pass, not an arbitrary delay.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const visible = await chips.locator("[data-focus-session]:visible").allTextContents();
    counts.push(visible.length);
    expect(visible).toEqual(ordered.slice(0, visible.length));
    if (desktop) {
      expect(visible.length, `${width}: more than the former three-chip cap`).toBeGreaterThan(3);
      const title = await row.locator("summary .focus-title").evaluate(el => {
        const range = document.createRange(); range.selectNode(el.firstChild!);
        return { available: el.clientWidth, text: range.getBoundingClientRect().width };
      });
      expect(title.available, "chips yield before the intention title").toBeGreaterThanOrEqual(title.text);
      for (const chip of await chips.locator("[data-focus-session]:visible .focus-chip-name").all()) {
        expect(await chip.evaluate(el => el.scrollWidth <= el.clientWidth), "shown chips retain readable names").toBe(true);
      }
      const remaining = ordered.slice(visible.length);
      await expect(chips.getByRole("button", { name: `${remaining.length} more sessions: ${remaining.join(", ")}`, exact: true })).toHaveText(`+${remaining.length}`);
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(45);
      const long = page.locator("#assistant-content .focus-today > li").nth(1);
      await expect(long.locator(":scope > .focus-chips [data-focus-session]:visible")).toHaveCount(0);
      await expect(long.locator(":scope > .focus-chips .focus-chip-more")).toHaveText("+12");
      const allFit = page.locator("#assistant-content .focus-today > li").last();
      await expect(allFit.locator(":scope > .focus-chips [data-focus-session]:visible")).toHaveText(["l", "a"]);
      await expect(allFit.locator(":scope > .focus-chips .focus-chip-more")).toBeHidden();
    } else {
      expect(visible).toHaveLength(12);
      await expect(chips.locator(".focus-chip-more")).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`chips-${width}.png`), fullPage: true });
  }
  if (desktop) {
    expect(new Set(counts).size, "resize changes how many chips fit").toBeGreaterThan(1);
    expect(counts[0]).toBe(counts.at(-1));
    await chips.getByRole("button", { name: /^\d+ more sessions:/ }).click();
  } else await row.locator("summary").click();
  await expect(row.locator(".focus-card-body [data-focus-session]")).toHaveText(names);
});

for (const transition of ["unlink", "sessions disappear"] as const) test(`C2: ${transition} clears the fitted reservation before rendering a longer title`, async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const names = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const replacement = "Review the updated deployment checklist";
  let removed = false;
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: 900 });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "another-project");
    if (!removed || transition === "unlink") body.sessions.push(...names.map(name => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}` },
    })));
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.document.intentions = [{ id: "changing-links", title: removed ? replacement : "Ship", done: false,
      createdAt: new Date().toISOString(), sessions: removed && transition === "unlink" ? [] : names.map(name => `mock:${name}`) }];
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const row = page.locator("#assistant-content .focus-today > li");
  const chips = row.locator(":scope > .focus-chips");
  await expect.poll(() => chips.locator("[data-focus-session]:visible").count()).toBeGreaterThan(3);
  if (desktop) expect(await row.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--focus-chips-width")))).toBeGreaterThan(200);
  removed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const title = row.locator("summary .focus-title");
  await expect(title).toHaveText(replacement);
  await expect(chips.locator("[data-focus-session]")).toHaveCount(0);
  for (const width of desktop ? [1440, 1280, 1440] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    if (desktop) {
      const size = await title.evaluate(el => {
        const range = document.createRange(); range.selectNode(el.firstChild!);
        return { available: el.clientWidth, text: range.getBoundingClientRect().width };
      });
      expect.soft(size.available, `${width}: no empty reservation truncates the replacement title`).toBeGreaterThanOrEqual(size.text);
      expect.soft(await row.evaluate(el => getComputedStyle(el).getPropertyValue("--focus-chips-width"))).toBe("0px");
    }
  }
  await page.screenshot({ path: info.outputPath(`c2-${transition.replaceAll(" ", "-")}.png`), fullPage: true });
  removed = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(title).toHaveText("Ship");
  await expect.poll(() => chips.locator("[data-focus-session]:visible").count()).toBeGreaterThan(3);
});
