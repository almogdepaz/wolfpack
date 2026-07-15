/**
 * Regression: scrollback drifts past user's viewport while output streams.
 *
 * Reported symptom: with the agent (or any process) producing output, scroll
 * up with trackpad — the FIRST visible row keeps changing as new lines push
 * into scrollback, even though the user scrolled away from the bottom to
 * READ that specific row. Visually presents as "the first line is duplicated"
 * because the user sees a row at viewport row 0, then on next frame that row
 * has moved to viewport row 1 and a different row has taken row 0.
 *
 * Root cause: public/app.ts monkey-patches `term.scrollToBottom` to no-op
 * while `_userScrolledUp = true`. ghostty-web calls scrollToBottom on every
 * `writeInternal()`. Without the call, ghostty's viewportY stays pinned but
 * `scrollbackLength` grows as new rows are pushed off the live screen — so
 * the SAME viewportY now resolves to a DIFFERENT absolute scrollback row.
 *
 * Correct behavior: when scroll-locked and new content arrives, viewportY
 * should INCREMENT by the number of lines that just got pushed into
 * scrollback, so the visible window stays anchored to the same absolute
 * scrollback rows.
 *
 * This test:
 *  1. opens a shell session
 *  2. fills scrollback with a counted sequence of rows
 *  3. scrolls up so user sees a known marker row at viewport row 0
 *  4. starts a streaming output loop in the background
 *  5. waits for streaming to push lines into scrollback
 *  6. asserts the marker row is STILL at viewport row 0 (i.e. the visible
 *     window stayed anchored to the same content the user was reading)
 *
 * Fails today because of the broken scroll-lock invariant. Will pass once
 * scrollToBottom is replaced with viewportY-bump-on-write logic.
 *
 * Requires: wolfpack-broker binary (guarded by skipIfNoBroker).
 * Desktop-only: trackpad/wheel scroll path; mobile uses touch (different code path).
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

const PROJECT_NAME = "wp-scroll-lock";
const SESSION_NAME = "scroll-lock";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let srv: BrokerTestServer | null = null;
let devDir: string | null = null;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  // realpathSync to dodge macOS /var → /private/var symlink which breaks
  // isUnderDevDir's realpath check (server sees /private/var, env had /var).
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-broker-scrolllock-")));
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

test("scroll-lock: viewport stays anchored while output streams into scrollback", async ({
  page,
}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "desktop", "desktop wheel-scroll path only");

  const createResp = await page.request.post(`${srv!.baseUrl}/api/create`, {
    data: { project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME },
  });
  if (!createResp.ok()) {
    const body = await createResp.text();
    throw new Error(`POST /api/create failed: ${createResp.status()} ${body}`);
  }

  await page.goto(srv!.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  // Use openSession() directly so the test doesn't depend on layout/click hit
  // testing (the sidebar list on desktop can render cards outside the viewport).
  await page.evaluate((name) => {
    // @ts-ignore — page-global
    openSession(name);
  }, SESSION_NAME);

  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5000 });

  // Wait for shell startup to settle.
  await wait(1500);

  // ── Step 1: emit MARK_NNNN sequence + start a streaming background loop
  // in ONE command, so we don't have to type anything after we scroll up.
  // (typing a key triggers _scrollLockKeydownHandler which resets the lock.)
  await canvas.click();
  await page.keyboard.type(
    'for i in $(seq 1 200); do echo MARK_$i; done',
  );
  await page.keyboard.press("Enter");
  await wait(1500);
  // Spawn a foreground streamer that emits STREAM_N lines on a slow interval.
  // We can't return to the prompt while it's foreground — but that's fine,
  // the test never types anything else.
  await page.keyboard.type(
    'for i in $(seq 1 200); do echo STREAM_$i; sleep 0.05; done',
  );
  await page.keyboard.press("Enter");
  // Don't wait for the loop to finish here — we want to scroll up WHILE it's
  // still producing output. Give it a moment to emit ~10-20 lines first so
  // there's something to scroll past.
  await wait(800);

  // Read the prompt to ensure the loop finished.
  const afterSeq = await page.evaluate(() => {
    // @ts-ignore — page-global state
    const term = state?.terminalController?.term;
    if (!term) return null;
    return {
      scrollbackLength: term.getScrollbackLength?.() ?? 0,
      viewportY: term.viewportY,
      rows: term.rows,
    };
  });
  expect(afterSeq, "must expose terminal handle via state").not.toBeNull();
  // 200 emitted MARK lines + STREAM partial run >> the ~47-row viewport,
  // so many should sit in scrollback by now.
  expect(afterSeq!.scrollbackLength).toBeGreaterThan(100);

  // ── Step 2: scroll up so a known MARK row is at viewport row 0 ──────────
  // Aim for ~30 lines up: lands somewhere in the middle of the MARK sequence.
  const TARGET_SCROLL_LINES = 30;
  await canvas.hover();
  // Dispatch wheel events synthetically so ghostty-web's wheel handler
  // converts to scrollLines. deltaY < 0 = scroll up.
  for (let i = 0; i < TARGET_SCROLL_LINES; i++) {
    await page.mouse.wheel(0, -40);
    await wait(20);
  }
  // Let the smooth-scroll animation settle.
  await wait(400);

  // Read what's now at viewport row 0.
  const anchored = await page.evaluate(() => {
    // @ts-ignore — page-global state
    const term = state?.terminalController?.term;
    if (!term) return null;
    const i = term.getScrollbackLength();
    const g = Math.floor(term.viewportY);
    // viewport row 0 maps to scrollback row (i - g + 0) when g > 0
    const line = g > 0 ? term.wasmTerm.getScrollbackLine(i - g) : term.wasmTerm.getLine(0);
    if (!line) return null;
    const text = line
      .map((c: { codepoint: number }) => (c.codepoint > 0 ? String.fromCodePoint(c.codepoint) : ""))
      .join("")
      .replace(/\s+$/, "");
    return { scrollbackLength: i, viewportY: term.viewportY, row0: text };
  });
  expect(anchored, "viewport-row-0 read must succeed").not.toBeNull();
  expect(
    anchored!.row0,
    `viewport row 0 should hold a MARK_N line after scroll-up (got: "${anchored!.row0}")`,
  ).toMatch(/MARK_\d+/);

  const anchoredMark = anchored!.row0;
  const anchoredScrollback = anchored!.scrollbackLength;

  // ── Step 3: Command is a browser modifier, not terminal input. Pressing it
  // must preserve the anchored viewport while STREAM output continues.
  await page.keyboard.down("Meta");
  await wait(50);
  await page.keyboard.up("Meta");
  await wait(2500);

  // ── Step 4: assert viewport row 0 still holds the same MARK row ─────────
  const after = await page.evaluate(() => {
    // @ts-ignore — page-global state
    const term = state?.terminalController?.term;
    if (!term) return null;
    const i = term.getScrollbackLength();
    const g = Math.floor(term.viewportY);
    const line = g > 0 ? term.wasmTerm.getScrollbackLine(i - g) : null;
    if (!line) return null;
    const text = line
      .map((c: { codepoint: number }) => (c.codepoint > 0 ? String.fromCodePoint(c.codepoint) : ""))
      .join("")
      .replace(/\s+$/, "");
    return { scrollbackLength: i, viewportY: term.viewportY, row0: text };
  });
  expect(after, "post-stream viewport-row-0 read must succeed").not.toBeNull();

  // The CRITICAL assertion. With the bug present:
  //   - scrollbackLength has grown (new STREAM_NNNN rows pushed off live screen)
  //   - viewportY is unchanged (scrollToBottom monkey-patch swallowed the calls)
  //   - therefore (scrollbackLength - viewportY) points to a NEW row, not
  //     the MARK row the user was reading
  //
  // With the fix in place:
  //   - viewportY incremented to compensate for scrollback growth
  //   - (scrollbackLength - viewportY) still resolves to the original MARK row
  expect(
    after!.scrollbackLength,
    "scrollback should have grown from streaming output",
  ).toBeGreaterThan(anchoredScrollback);
  expect(
    after!.row0,
    `viewport row 0 should still anchor the same content the user was reading
       before streaming began. anchored: "${anchoredMark}"
       now:      "${after!.row0}"
       scrollback grew: ${anchoredScrollback} -> ${after!.scrollbackLength}
       viewportY: ${anchored!.viewportY} -> ${after!.viewportY}`,
  ).toBe(anchoredMark);
});
