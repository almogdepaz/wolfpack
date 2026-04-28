/**
 * Broker copy — verify the "Copy session" mobile button writes a plain-text
 * snapshot of the broker-owned session to navigator.clipboard.
 *
 * Strategy: type a marker via the WS connection, click the kb-copy button,
 * read clipboard via navigator.clipboard.readText(). The route under test is
 * GET /api/copy-text which round-trips through BrokerBackend.capturePane →
 * broker `snapshot` RPC → plain-text rendering.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

const PROJECT_NAME = "wp-broker-copy";
const SESSION_NAME = "copy-shell";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let srv: BrokerTestServer | null = null;
let devDir: string | null = null;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  devDir = mkdtempSync(join(tmpdir(), "wp-broker-copy-"));
  mkdirSync(join(devDir, PROJECT_NAME));
  srv = await start({ envOverrides: { WOLFPACK_DEV_DIR: devDir } });
});

test.afterAll(async () => {
  await srv?.teardown();
  srv = null;
  if (devDir) {
    try { rmSync(devDir, { recursive: true, force: true }); } catch { /* swallow */ }
    devDir = null;
  }
});

test("broker copy: kb-copy button writes plain-text snapshot to clipboard", async ({ browser }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name === "desktop", "mobile keyboard accessory only");

  const marker = `WP_COPY_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  // Create the session.
  const createResp = await fetch(`${srv!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME }),
  });
  expect(createResp.ok, "POST /api/create").toBeTruthy();

  // Browser context with clipboard permission granted.
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.goto(srv!.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: SESSION_NAME }).first().click();

  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5000 });

  // Wait for prompt to settle and type marker.
  await wait(1500);
  await canvas.click();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await wait(800); // give broker time to drain PTY into snapshot

  // Click the copy button — overlay shows "copied N chars" on success.
  await page.locator(".kb-key.kb-copy").click();

  // Read clipboard. The button writes to navigator.clipboard.
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard, "clipboard contains pre-copy marker").toContain(marker);
  // Plain-text contract: no ANSI escape sequences.
  expect(clipboard, "clipboard text contains no ESC sequences").not.toContain("\x1b");

  await ctx.close();
});
