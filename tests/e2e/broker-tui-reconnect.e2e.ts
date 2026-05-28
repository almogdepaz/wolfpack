/**
 * Broker TUI (alt-screen) reconnect — enter alt-screen with a deterministic
 * fixture, force WS reconnect, assert post-reattach canvas matches pre-reattach
 * alt-screen content with no scrollback bleed-through from the main screen.
 *
 * Requires: wolfpack-broker binary (guarded by skipIfNoBroker).
 * Mobile-only: tests the unified /ws/pty terminal path.
 *
 * Strategy:
 *  1. Start a broker server with WOLFPACK_DEV_DIR pointing to a real temp dir.
 *  2. Create a shell session via POST /api/create.
 *  3. Echo MAIN_SCREEN_PRE_TUI on the main screen so we can later assert it does
 *     NOT appear in the alt-screen snapshot (scrollback isolation check).
 *  4. Enter alt-screen via `printf '\033[?1049h'` + cursor moves + colored text,
 *     placing TUI_LINE_TOP (row 1), TUI_RED_TEXT in red+bold (row 5), and
 *     TUI_LINE_BOT (row 9) at deterministic positions.
 *  5. Wait for terminal output to settle (idle), confirming the fixture ran.
 *  6. Close WS (code 1006) → reconnecting banner → auto-retry → conn-2 opens.
 *  7. Assert conn-2 prefill (broker snapshot rendered to ANSI) contains all
 *     three TUI tokens — "DOM/canvas comparison" via ANSI content: the broker
 *     renders the alt-screen visible_screen cell-by-cell, so token presence
 *     proves the canvas would display the correct pre-reattach TUI state.
 *  8. Assert conn-2 prefill does NOT contain MAIN_SCREEN_PRE_TUI — the broker
 *     tracks the alt-screen buffer independently; main-screen scrollback must
 *     not cross the alt-screen boundary. A failure here is a real broker bug.
 *  9. Assert prefill preamble contains \x1b[2J + \x1b[3J (renderSnapshotToAnsi
 *     always emits these to prevent leftover client-side terminal state).
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_NAME = "wp-tui-reconnect";
const SESSION_NAME = "tui-reconnect";

// Unique tokens embedded in TUI visible screen at deterministic positions.
const TUI_TOKEN_TOP = "TUI_LINE_TOP";  // row 1, col 1
const TUI_TOKEN_RED = "TUI_RED_TEXT";  // row 5, col 5 — red+bold styled
const TUI_TOKEN_BOT = "TUI_LINE_BOT";  // row 9, col 1

// Token written on main screen BEFORE entering alt-screen.
// The alt-screen has its own empty scrollback buffer; this token must not
// appear anywhere in the alt-screen snapshot prefill (no bleed-through).
const MAIN_TOKEN = "MAIN_SCREEN_PRE_TUI";

// Alt-screen fixture command (typed verbatim into the shell):
//   \033[?1049h  switch to alt-screen buffer (main screen preserved but hidden)
//   \033[2J      clear alt-screen
//   \033[H       cursor home (1,1)
//   \033[1;1H…  place TUI_LINE_TOP at row 1, col 1
//   \033[5;5H…  place TUI_RED_TEXT in red+bold at row 5, col 5
//   \033[0m      reset SGR
//   \033[9;1H…  place TUI_LINE_BOT at row 9, col 1
//
// Single-quoting the argument means zsh passes \033 literally to printf, which
// interprets it as ESC (octal 033). The terminal (120×40) has room at row 9
// without triggering scrollback.
const TUI_CMD =
  `printf '\\033[?1049h\\033[2J\\033[H\\033[1;1H${TUI_TOKEN_TOP}\\033[5;5H\\033[31;1m${TUI_TOKEN_RED}\\033[0m\\033[9;1H${TUI_TOKEN_BOT}'`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip ANSI/VT escape sequences for plain-text matching. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g, "")
    .replace(/\x1b./gs, "")
    .replace(/\r/g, "");
}

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
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-broker-tui-")));
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

test("broker TUI: alt-screen reconnect restores canvas and has no scrollback bleed-through", async ({
  page,
}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name === "desktop", "mobile viewport only");

  // ── Create a shell session before navigating ──
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

  // ── Wait for shell startup to reach idle (~600 ms of no output) ──
  let lastLen = 0;
  let idleCount = 0;
  const idleDeadline = Date.now() + 8000;
  while (Date.now() < idleDeadline) {
    await wait(200);
    if (conn1Output.length === lastLen) {
      if (++idleCount >= 3) break;
    } else {
      idleCount = 0;
      lastLen = conn1Output.length;
    }
  }

  // ── Write main-screen token (used later to verify no alt-screen bleed-through) ──
  await page.locator("#kb-open-btn").click();
  await page.locator("#mobile-kb-proxy").focus();
  await page.keyboard.type(`echo "${MAIN_TOKEN}"`);
  await page.keyboard.press("Enter");

  // Poll until main-screen token appears in conn1 output.
  let mainVisible = false;
  const mainDeadline = Date.now() + 8000;
  while (Date.now() < mainDeadline) {
    await wait(200);
    if (stripAnsi(conn1Output).includes(MAIN_TOKEN)) {
      mainVisible = true;
      break;
    }
  }
  expect(mainVisible, `${MAIN_TOKEN} must appear on main screen before TUI`).toBeTruthy();

  // ── Enter alt-screen and draw the deterministic TUI fixture ──
  // Send the long escape-heavy command directly; mobile keyboard emulation can
  // mangle long quoted strings while wrapping in the proxy input.
  await page.evaluate((cmd) => {
    const w = window as unknown as { state?: { terminalController?: { send?: (data: Uint8Array) => void } } };
    w.state?.terminalController?.send?.(new TextEncoder().encode(cmd + "\r"));
  }, TUI_CMD);

  // Wait for terminal output to settle after the TUI command. The shell will
  // execute printf (drawing the TUI) then emit a new prompt — idle detection
  // confirms the fixture completed and the broker snapshot is stable.
  lastLen = conn1Output.length;
  idleCount = 0;
  const tuiIdleDeadline = Date.now() + 10_000;
  while (Date.now() < tuiIdleDeadline) {
    await wait(200);
    if (conn1Output.length === lastLen) {
      if (++idleCount >= 3) break;
    } else {
      idleCount = 0;
      lastLen = conn1Output.length;
    }
  }

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

  // ── Assert prefill was received on conn-2 ──
  // The reconnect banner can hide as soon as the WS opens; wait for server
  // snapshot bytes separately.
  await expect.poll(() => conn2Prefill.length, {
    message: "prefill bytes received on conn-2",
    timeout: 5000,
  }).toBeGreaterThan(0);

  const prefillPlain = stripAnsi(conn2Prefill).replace(/\r/g, "\n");

  // ── Post-reattach canvas matches pre-reattach alt-screen content ──────────
  // The broker's snapshot captures visible_screen (the alt-screen buffer) and
  // renders it cell-by-cell. All three TUI tokens must appear in the prefill,
  // confirming the canvas would display the same state as before the disconnect.
  expect(prefillPlain, "prefill must contain TUI_LINE_TOP (row 1, col 1)").toContain(TUI_TOKEN_TOP);
  expect(prefillPlain, "prefill must contain TUI_RED_TEXT (row 5, col 5, red+bold)").toContain(TUI_TOKEN_RED);
  expect(prefillPlain, "prefill must contain TUI_LINE_BOT (row 9, col 1)").toContain(TUI_TOKEN_BOT);

  // ── No scrollback bleed-through from main screen into alt-screen ──────────
  // The broker tracks alt-screen and main-screen as separate buffers. The
  // alt-screen snapshot must not include main-screen scrollback. Any failure
  // here indicates the broker is incorrectly merging main-screen content into
  // the alt-screen snapshot — a real correctness bug, not a test over-assertion.
  expect(
    prefillPlain,
    "prefill must NOT contain main-screen token (no scrollback bleed-through)",
  ).not.toContain(MAIN_TOKEN);

  // ── Prefill preamble includes clear sequences ──────────────────────────────
  // renderSnapshotToAnsi always leads with \x1b[2J (clear visible) and \x1b[3J
  // (clear scrollback) so the client can't retain stale terminal state from any
  // prior connection.
  expect(conn2Prefill, "prefill must clear visible screen (\\x1b[2J)").toContain("\x1b[2J");
  expect(conn2Prefill, "prefill must clear scrollback (\\x1b[3J)").toContain("\x1b[3J");
});
