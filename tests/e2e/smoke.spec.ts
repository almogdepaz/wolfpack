/**
 * Smoke test — validates Playwright + test server wiring works.
 */
import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("serves the PWA index page", async ({ page }) => {
  await page.goto(srv.baseUrl);
  // Page should load without errors — check for some known content
  const body = await page.textContent("body");
  expect(body).toBeTruthy();
});

test("api/info returns server metadata", async ({ page }) => {
  const res = await page.request.get(`${srv.baseUrl}/api/info`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toHaveProperty("name");
  expect(body).toHaveProperty("version");
});

test("api/sessions returns mock sessions", async ({ page }) => {
  const res = await page.request.get(`${srv.baseUrl}/api/sessions`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.sessions.length).toBeGreaterThanOrEqual(2);
  const names = body.sessions.map((s: { name: string }) => s.name);
  expect(names).toContain("test-project");
  expect(names).toContain("another-project");
});

test("api/send dispatches to mock tmux", async ({ page }) => {
  // Navigate first so page.request sends the correct Origin header
  await page.goto(srv.baseUrl);
  const res = await page.request.post(`${srv.baseUrl}/api/send`, {
    data: { session: "test-project", text: "echo hello" },
  });
  // Should succeed (200) — actual tmux call is stubbed
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toEqual({ ok: true });
});
