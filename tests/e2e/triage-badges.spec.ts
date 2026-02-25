/**
 * Triage badges (UX-05) — session list shows color-coded status badges.
 *
 * Verifies that /api/sessions returns triage classification and the frontend
 * renders correct badge labels/colors on session cards.
 *
 * Test-server provides 4 sessions with different triage states:
 *   - prompt-project: pane has y/n prompt → "needs-input"
 *   - error-project:  pane has "Error:" → "error"
 *   - test-project:   activity = now, no pattern → "running"
 *   - another-project: activity = 30s ago, no pattern → "idle"
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

test("session cards show triage badges", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Verify prompt-project has needs-input badge
  const promptCard = page.locator(".card", { hasText: "prompt-project" }).first();
  await expect(promptCard).toBeVisible();
  await expect(promptCard.locator(".triage-badge.needs-input")).toBeVisible();
  await expect(promptCard.locator(".triage-badge")).toContainText("input");

  // Verify error-project has error badge
  const errorCard = page.locator(".card", { hasText: "error-project" }).first();
  await expect(errorCard).toBeVisible();
  await expect(errorCard.locator(".triage-badge.error")).toBeVisible();
  await expect(errorCard.locator(".triage-badge")).toContainText("error");
});

test("sessions sorted by triage priority (needs-input first)", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Get all session card names in render order (includes badge text)
  const names = await page.locator(".card .card-name").allTextContents();

  // Find index by session name substring (badge text is appended but doesn't affect includes)
  const promptIdx = names.findIndex((n) => n.includes("prompt-project"));
  const errorIdx = names.findIndex((n) => n.includes("error-project"));
  const runningIdx = names.findIndex((n) => n.includes("test-project"));
  const idleIdx = names.findIndex((n) => n.includes("another-project"));

  expect(promptIdx).toBeGreaterThanOrEqual(0);
  expect(errorIdx).toBeGreaterThanOrEqual(0);

  // Priority order: needs-input < error < running < idle
  expect(promptIdx).toBeLessThan(errorIdx);
  expect(errorIdx).toBeLessThan(runningIdx);
  expect(runningIdx).toBeLessThan(idleIdx);
});

test("running session has green badge", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  const runningCard = page.locator(".card", { hasText: "test-project" }).first();
  await expect(runningCard).toBeVisible();
  await expect(runningCard.locator(".triage-badge.running")).toBeVisible();
  await expect(runningCard.locator(".triage-badge")).toContainText("running");
});

test("idle session has gray badge", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  const idleCard = page.locator(".card", { hasText: "another-project" }).first();
  await expect(idleCard).toBeVisible();
  await expect(idleCard.locator(".triage-badge.idle")).toBeVisible();
  await expect(idleCard.locator(".triage-badge")).toContainText("idle");
});
