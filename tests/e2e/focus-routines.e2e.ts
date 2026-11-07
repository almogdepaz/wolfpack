import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

const shots = join(process.cwd(), ".plans/screenshots");
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const idle = { catchingUp: null, stale: null, unreachable: [], surfaced: null };
async function withRoutines(page: Page, routines: Record<string, unknown>) {
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.routines = { ...body.routines, ...idle, ...routines };
    await route.fulfill({ response, json: body });
  });
}
async function shot(page: Page, name: string, desktop: boolean) {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `focus-p2-${name}-${desktop ? 1440 : 390}.png`), fullPage: true });
}
test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("sgt just booted: catching up since … with machine count, nudge greyed from an earlier day", async ({ page }, info) => {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(current.routines).toMatchObject({ unreachable: [], surfaced: null });
  await withRoutines(page, { catchingUp: { machines: 2, since: ago(30) } });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toContainText(/catching up since \w+ \d\d:\d\d · 2 machines/);
  await expect(block.locator(".focus-nudge.from")).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await shot(page, "catching-up", info.project.name === "desktop");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-header")).toContainText("2 machines");
});

test("stale, peer not reached and unacked inbox; catch up now sends the catch-up routine", async ({ page }, info) => {
  await withRoutines(page, { stale: { since: ago(50) }, unreachable: [{ name: "macbook", since: ago(26) }], surfaced: { sends: 4 } });
  let caughtUp = 0;
  await page.route("**/api/focus/catch-up", route => { caughtUp++; return route.continue(); });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toContainText(/quiet since \w+ \d\d:\d\d/);
  await expect(block).toContainText(/macbook not reached since \w+ \d\d:\d\d/);
  await expect(block).toContainText("inbox not acknowledged after 4 sends");
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await shot(page, "stale", info.project.name === "desktop");
  await expect(block.getByRole("button", { name: "catch up now" })).toHaveCount(1);
  await block.getByRole("button", { name: "catch up now" }).click();
  await expect.poll(() => caughtUp).toBe(1);
});

test("yesterday row opens the day note dialog; mark read hides it on every device", async ({ page }, info) => {
  const yesterday = localDay(Date.now() - 864e5);
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "day-summary", summary: { date: yesterday, done: 4, carried: 2, questions: 1 } }] } })).ok()).toBe(true);
  mkdirSync(join(server.home, ".wolfpack/assistant/days"), { recursive: true });
  writeFileSync(join(server.home, ".wolfpack/assistant/days", `${yesterday}.md`), `# ${yesterday}\n\n## sessions\n\n- prompt-project (/tmp, pi) · 3 state changes\n\n## assistant\n\nShipped the focus view. Carried: broker leak.\n`);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  await expect(view.locator(".focus-yesterday")).toContainText("yesterday4 done · 2 carried over · 1 question");
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  await view.getByRole("button", { name: `Read day note for ${yesterday}` }).click();
  const dialog = page.locator("#app-dialog");
  await expect(dialog).toContainText("Carried: broker leak.");
  expect((await new AxeBuilder({ page }).include("#app-dialog").analyze()).violations).toEqual([]);
  await shot(page, "day-note", info.project.name === "desktop");
  await page.locator("#app-dialog-confirm").click();
  await expect(view.locator(".focus-yesterday")).toHaveCount(0);
  expect((await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).document.seenDayNoteAt).toEqual(expect.any(String));
});

test("assistant timing settings validate and save to the home machine's bridge settings", async ({ page }, info) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.locator("#assistant-view").getByRole("button", { name: /assistant.*settings/i }).click();
  const form = page.getByRole("form", { name: "Assistant routine timing" });
  const quiet = form.getByRole("spinbutton", { name: "Day review after quiet (minutes)" });
  await expect(quiet).toHaveValue("90");
  await expect(form.getByLabel("Day review fallback time")).toHaveValue("03:00");
  await quiet.fill("10");
  await form.getByRole("button", { name: "Save timing" }).click();
  await expect(page.locator("#assistant-timing-status")).toHaveText("quietMinutes must be a whole number from 15 to 480");
  expect((await new AxeBuilder({ page }).include("#settings-assistant").analyze()).violations).toEqual([]);
  await shot(page, "settings-invalid", info.project.name === "desktop");
  await quiet.fill("45");
  await form.getByRole("spinbutton", { name: "Catch-up debounce (minutes)" }).fill("5");
  await form.getByRole("button", { name: "Save timing" }).click();
  await expect(page.locator("#assistant-timing-status")).toHaveText("Routine timing saved.");
  expect((await (await page.request.get(`${server.baseUrl}/api/settings`)).json()).settings.assistant).toEqual({ quietMinutes: 45, fallbackTime: "03:00", catchUpDebounceMinutes: 5, journalRetentionDays: 30 });
});
