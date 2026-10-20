import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

test("display-only meta and raw footer fallback preserve Done on y/n text", async ({ page }) => {
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const data: { sessions: Array<{ name: string; [key: string]: unknown }> } = await response.json();
    data.sessions = data.sessions.slice(0, 2).map((session, index) => ({
      ...session,
      lastLine: "Do you want to continue? (y/n)",
      footer: index ? "↑12k ↓3k unknown-footer" : "raw footer must not display",
      meta: index ? undefined : { model: "gpt-6-astra", reasoning: "medium", contextPct: 85, contextLimit: 272000, cost: 42.822, costTag: "sub" },
      runtimeState: { state: "done", authority: "program", source: "program-status", freshness: "fresh", stale: false },
    }));
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  const cards = page.locator("#session-list .card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator(".card-preview")).toHaveText("Do you want to continue? (y/n)");
  await expect(cards.first().locator(".card-meta")).toContainText("gpt-6-astra · medium");
  await expect(cards.first().locator(".card-meta")).toContainText("ctx 85% (272k limit)");
  await expect(cards.first().locator(".card-meta")).toContainText("$42.822 (sub)");
  await expect(cards.first().locator(".card-meta")).not.toContainText("raw footer must not display");
  const context = cards.first().locator(".session-meta-context");
  await expect(context).toHaveCSS("color", "rgb(246, 195, 92)");
  await expect(cards.nth(1).locator(".card-meta")).toContainText("↑12k ↓3k unknown-footer");
  for (const card of await cards.all()) {
    await expect(card).toHaveClass(/tier-idle/);
    await expect(card.locator(".status")).toHaveText("Done");
  }
});
