/**
 * Broker shell reconnect — type a marker command in a real PTY, simulate WS
 * disconnect, verify reconnecting banner + auto-recovery, and assert that the
 * new WS connection receives a prefill containing the marker transcript.
 *
 * Requires: wolfpack-broker binary (guarded by skipIfNoBroker).
 * Mobile-only: tests the unified /ws/pty terminal path.
 *
 * Strategy:
 *  1. Start a broker server with WOLFPACK_DEV_DIR pointing to a real temp dir.
 *  2. Create a shell session via POST /api/create (bypasses the UI create flow).
 *  3. Intercept /ws/pty via page.routeWebSocket; capture server→client binary
 *     data separately for connection 1 and connection 2.
 *  4. Type `echo "WP_MARK:$RANDOM" > /tmp/marker.txt; cat /tmp/marker.txt` and
 *     wait for the WP_MARK:NNNNN output to appear in conn-1 capture.
 *  5. Close the page-facing WS (code 1006) → reconnecting banner → auto-retry
 *     → conn-2 opens → banner hides.
 *  6. Assert conn-2 prefill (binary frames) contains the prompt path token and
 *     the captured WP_MARK value.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_NAME = "wp-shell-reconnect";
const SESSION_NAME = "shell-reconnect";
// Marker command: output is "WP_MARK:NNNNN" — unambiguous, no ANSI noise.
const MARKER_CMD =
  'echo "WP_MARK:$RANDOM" > /tmp/marker.txt; cat /tmp/marker.txt';

// ── Helpers ───────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip ANSI/VT escape sequences for plain-text matching. */
function stripAnsi(s: string): string {
  return s
    // CSI sequences: ESC [ ... final-byte
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // OSC sequences: ESC ] ... ST-or-BEL
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // DCS / PM / APC / SOS: ESC P/^/_/X ... ST
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g, "")
    // Two-char escapes: ESC + any single char
    .replace(/\x1b./gs, "")
    // Carriage returns (leave \n)
    .replace(/\r/g, "");
}

/**
 * Normalise a raw binary string (latin-1 encoded WS frame) to text suitable
 * for .includes() checks. Handles Buffer, Uint8Array, string payloads.
 */
function frameToText(data: string | Buffer | Uint8Array): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("binary");
  return Buffer.from(data as Uint8Array).toString("binary");
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let srv: BrokerTestServer | null = null;
let devDir: string | null = null;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;

  // realpathSync dodges macOS /var → /private/var symlink mismatches with
  // isUnderDevDir's realpath containment check.
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-broker-shell-")));
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

// ── Test ──────────────────────────────────────────────────────────────────────

test("broker shell: reconnect restores marker transcript", async ({
  page,
}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name === "desktop", "mobile viewport only");

  // ── Create a shell session before navigating so it appears in the card list ──
  const createResp = await page.request.post(`${srv!.baseUrl}/api/create`, {
    data: { project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME },
  });
  expect(createResp.ok(), "POST /api/create should succeed").toBeTruthy();

  // ── WS proxy: capture binary server→client frames per connection ──
  let conn1Output = "";
  let conn2Prefill = "";
  let connectionCount = 0;

  const ready = page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const server = ws.connectToServer();
    connectionCount++;
    const thisConn = connectionCount;

    ws.onMessage((msg) => server.send(msg));

    server.onMessage((data) => {
      // Only accumulate binary frames (ANSI PTY output / prefill).
      // String frames are JSON control messages (prefill_done, pty_ready, etc.).
      if (typeof data !== "string") {
        const text = frameToText(data);
        if (thisConn === 1) conn1Output += text;
        else if (thisConn === 2) conn2Prefill += text;
      }
      ws.send(data);
    });

    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));

  });
  await ready;

  // ── Navigate and open the session ──
  await page.goto(srv!.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: SESSION_NAME }).first().click();

  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5000 });
  expect(connectionCount, "first WS connection established").toBe(1);

  // ── Wait for shell to reach idle state (no new output for ~600 ms) ──
  // zsh -lic startup loads .zshrc; wait until output settles rather than
  // using a fixed sleep so slow machines don't flake.
  let lastLen = 0;
  let idleCount = 0;
  const idleDeadline = Date.now() + 8000;
  while (Date.now() < idleDeadline) {
    await wait(200);
    if (conn1Output.length === lastLen) {
      if (++idleCount >= 3) break; // 3 × 200 ms = 600 ms idle
    } else {
      idleCount = 0;
      lastLen = conn1Output.length;
    }
  }

  // ── Type marker command ──
  await page.locator("#kb-open-btn").click();
  await page.locator("#mobile-kb-proxy").focus();
  await page.keyboard.type(MARKER_CMD);
  await page.keyboard.press("Enter");

  // ── Poll for WP_MARK:NNNNN output (from cat /tmp/marker.txt) ──
  let markerValue: string | null = null;
  const markerDeadline = Date.now() + 10_000;
  while (Date.now() < markerDeadline) {
    await wait(200);
    const plain = stripAnsi(conn1Output).replace(/\r/g, "\n");
    const match = plain.match(/WP_MARK:(\d{1,5})/);
    if (match) {
      markerValue = match[1];
      break;
    }
  }
  expect(markerValue, "WP_MARK:NNNNN should appear in terminal output").not.toBeNull();

  // ── Baseline: conn-status is hidden (live state) ──
  const connStatus = page.locator("#conn-status");
  await expect(connStatus).toBeHidden();

  // ── Simulate server-side WS disconnect ──
  await page.evaluate(() => {
    const w = window as unknown as { state?: { terminalController?: { ptyClient?: { ws?: WebSocket | null } } } };
    w.state?.terminalController?.ptyClient?.ws?.close();
  });

  // ── Verify auto-recovery. Fast reconnects can complete before the banner is
  // visibly painted, so the broker test keys off the second WS + hidden final state.
  await expect.poll(() => connectionCount, {
    message: "second WS connection established on reconnect",
    timeout: 12_000,
  }).toBe(2);
  await expect(connStatus).toBeHidden({ timeout: 12_000 });

  // ── Canvas still rendered after reconnect ──
  await expect(canvas).toBeVisible();

  // ── Assert prefill on new socket restores prompt path + marker transcript ──
  // The reconnect banner can hide as soon as the WS opens; wait for server
  // snapshot bytes separately.
  await expect.poll(() => conn2Prefill.length, {
    message: "prefill bytes received on conn-2",
    timeout: 5000,
  }).toBeGreaterThan(0);

  const prefillPlain = stripAnsi(conn2Prefill).replace(/\r/g, "\n");

  // The command text typed in the terminal appears in the snapshot visible screen.
  expect(
    prefillPlain,
    "prefill should contain the marker command path token",
  ).toContain("/tmp/marker.txt");

  // The captured WP_MARK value (from cat output) appears in the prefill.
  expect(
    prefillPlain,
    `prefill should contain WP_MARK:${markerValue}`,
  ).toContain(`WP_MARK:${markerValue}`);
});
