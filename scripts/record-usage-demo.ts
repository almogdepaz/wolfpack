#!/usr/bin/env bun
/**
 * Records the README/homepage usage demo against a LIVE wolfpack server with
 * real broker-backed sessions (no mocks). Headless chromium drives the UI;
 * frames come from the CDP screencast (lossless PNG, only when the screen
 * changes), then ffmpeg assembles the mp4 (homepage) and gif (README).
 *
 *   bun run scripts/record-usage-demo.ts --sessions polybot,warclaws,wolfpack-2 --remote looper-ai
 *
 * flags:
 *   --base-url <url>          default http://127.0.0.1:18790
 *   --sessions a,b,c          local session names to open/switch (first = hero)
 *   --remote <name>           a session on a remote machine to open near the end (optional)
 *   --local-label <text>      placeholder shown instead of the local machine name
 *   --remote-label <text>     placeholder shown instead of remote machine names
 *   --out <dir>               output dir (default .demo-out/)
 *   --dry                     checkpoint screenshots only, no frames
 *   --encode <frames-dir>     skip recording; encode an existing take (frames.json inside)
 *   --stills-only             only capture the still images (poster, desktop terminal, mobile dashboard + terminal)
 *   --mobile-only             only record the phone clip (dashboard → session → terminal → back → next session)
 *   --no-mobile               skip the phone clip after the desktop one
 *   --no-stills               skip the stills after recording
 *   --no-warm                 skip the warm-up pass (every session opened once before frames start, so
 *                             on-camera opens are keep-mounted hits; the pool is raised to hold them all)
 *   WOLFPACK_FFMPEG=<path>    full ffmpeg build (libx264 + gif); PATH and the Cypress cache are probed otherwise
 *
 * Machine names are rewritten at the network layer (`/api/info`, `/api/machine`)
 * so the recording never shows real hostnames; the product code is untouched.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index]!;
  if (!key.startsWith("--")) continue;
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) { args.set(key.slice(2), next); index += 1; }
  else args.set(key.slice(2), "true");
}

const BASE_URL = args.get("base-url") ?? "http://127.0.0.1:18790";
const SESSIONS = (args.get("sessions") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const REMOTE_SESSION = args.get("remote");
const LOCAL_LABEL = args.get("local-label") ?? "WORKSTATION";
const REMOTE_LABEL = args.get("remote-label") ?? "MACBOOK";
const OUT_DIR = resolve(args.get("out") ?? ".demo-out");
const DRY = args.get("dry") === "true";
const ENCODE_ONLY = args.get("encode");
const STILLS_ONLY = args.get("stills-only") === "true";
const MOBILE_ONLY = args.get("mobile-only") === "true";
const WITH_MOBILE = args.get("no-mobile") !== "true";
const WITH_STILLS = args.get("no-stills") !== "true";
const WITH_WARM = args.get("no-warm") !== "true";
const WIDTH = 1600;
const HEIGHT = 1000;
const GIF_WIDTH = 900;
const GIF_FPS = 4;
const MP4_WIDTH = 1280;
const MP4_FPS = 30;
const FFMPEG = resolveFfmpeg();

if (!ENCODE_ONLY && !STILLS_ONLY && !MOBILE_ONLY && SESSIONS.length < 2) {
  console.error("need at least two --sessions to demonstrate switching");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

/** A full ffmpeg (libx264 + gif + palette filters). Playwright's bundled build only muxes webm. */
function resolveFfmpeg(): string {
  const candidates = [
    process.env.WOLFPACK_FFMPEG,
    Bun.which("ffmpeg"),
    ...(() => {
      const cypress = join(homedir(), ".cache/Cypress");
      try {
        return readdirSync(cypress).map((version) =>
          join(cypress, version, "Cypress/resources/app/packages/server/node_modules/@ffmpeg-installer/linux-x64/ffmpeg"));
      } catch { return []; }
    })(),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error("no ffmpeg with libx264 found; set WOLFPACK_FFMPEG");
}

const CURSOR_SCRIPT = `
(() => {
  const style = document.createElement("style");
  style.textContent = \`
    #demo-cursor{position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;left:0;top:0;transform:translate(-3px,-2px);transition:opacity .2s}
    #demo-cursor.press svg{transform:scale(.85);transform-origin:4px 3px}
    #demo-cursor svg{transition:transform .08s}
  \`;
  const cursor = document.createElement("div");
  cursor.id = "demo-cursor";
  cursor.style.opacity = "0";
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8.5-6.2 1.6 3.6 6.4-2.6 1.5-3.6-6.4L5 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const mount = () => { document.documentElement.appendChild(style); document.documentElement.appendChild(cursor); };
  if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("mousemove", (event) => {
    cursor.style.opacity = "1";
    cursor.style.left = event.clientX + "px";
    cursor.style.top = event.clientY + "px";
  }, true);
  window.addEventListener("mousedown", () => cursor.classList.add("press"), true);
  window.addEventListener("mouseup", () => cursor.classList.remove("press"), true);
})();
`;

type Scene = { readonly name: string; readonly at: number };
type Frame = { readonly file: string; readonly timestamp: number };
const scenes: Scene[] = [];
let shotIndex = 0;
const started = Date.now();

async function checkpoint(page: Page, name: string): Promise<void> {
  scenes.push({ name, at: Date.now() - started });
  if (!DRY) return;
  shotIndex += 1;
  await page.screenshot({ path: join(OUT_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`) });
}

let pointer = { x: WIDTH / 2, y: HEIGHT / 2 };
async function glide(page: Page, target: Locator, options: { readonly settle?: number } = {}): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`no bounding box for ${target}`);
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(to.x - pointer.x, to.y - pointer.y);
  const steps = Math.max(8, Math.min(28, Math.round(distance / 30)));
  await page.mouse.move(to.x, to.y, { steps });
  pointer = to;
  await page.waitForTimeout(options.settle ?? 180);
}

async function glideClick(page: Page, target: Locator, settle = 180): Promise<void> {
  await glide(page, target, { settle });
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

async function waitLive(page: Page, timeout = 8000): Promise<void> {
  await page.locator("#desktop-terminal-container").waitFor({ state: "visible", timeout });
  await page
    .locator('#desktop-terminal-container[data-terminal-load-state="live"]')
    .waitFor({ state: "attached", timeout })
    .catch(() => undefined);
}

function cardOpen(page: Page, session: string): Locator {
  return page.locator(`.card-open[data-session="${session}"][data-machine=""]`).first();
}

function sidebarCard(page: Page, session: string): Locator {
  return page.locator(`#sidebar-session-list .card-open[data-session="${session}"][data-machine=""]`).first();
}

/** Same name may exist locally; a remote card carries the machine origin in data-machine. */
function remoteSidebarCard(page: Page, session: string): Locator {
  return page.locator(`#sidebar-session-list .card-open[data-session="${session}"]:not([data-machine=""])`).first();
}

/**
 * Remote extension consent lives in page memory (public/extension-transport.ts) and its prompt
 * prints the peer's real origin, so accept it before frames start. "Not now" would re-prompt on camera.
 */
async function trustRemoteExtensions(page: Page): Promise<void> {
  const prompt = page.locator('form.extension-access-prompt[aria-label="Trust selected machine browser code?"]');
  if (await prompt.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await prompt.getByRole("button", { name: "Trust this inventory" }).click();
    await prompt.waitFor({ state: "detached", timeout: 5000 });
  }
}

type Viewport = { readonly width: number; readonly height: number };

/** A context whose machine names are placeholders and whose pointer is drawn. */
async function demoContext(browser: Browser, viewport: Viewport, mobile = false, scale = 1): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: "dark",
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: IPHONE_UA } : {}),
  });
  const localOrigin = new URL(BASE_URL).origin;
  await context.route("**/api/info", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, name: LOCAL_LABEL } });
  });
  await context.route("**/api/machine", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { machine?: Record<string, unknown> } & Record<string, unknown>;
    const isLocal = new URL(route.request().url()).origin === localOrigin;
    const machine = { ...(body.machine ?? {}), displayName: isLocal ? LOCAL_LABEL : REMOTE_LABEL };
    await route.fulfill({ response, json: { ...body, machine } });
  });
  if (!mobile) await context.addInitScript(CURSOR_SCRIPT);
  if (!mobile && WITH_WARM) {
    // debug-gated pool size (src/terminal-pool-debug.ts): keep every warmed session resident
    const poolSize = Math.min(6, SESSIONS.length + (REMOTE_SESSION ? 1 : 0) + 1);
    await context.addInitScript((size: number) => {
      try {
        localStorage.setItem("wolfpackDebug", "1");
        localStorage.setItem("wolfpackTerminalPoolSize", String(size));
      } catch { /* storage unavailable: default pool */ }
    }, poolSize);
  }
  return context;
}

async function openDashboard(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(BASE_URL + "/", { waitUntil: "networkidle" });
  await page.locator(".card-open").first().waitFor({ timeout: 15000 });
  return page;
}

async function run(): Promise<void> {
  const browser = await chromium.launch();
  const context = await demoContext(browser, { width: WIDTH, height: HEIGHT });
  const page = await openDashboard(context);

  // warm-up (not recorded): open every session once so the pool holds them, ending on the hero.
  // returning to the dashboard would evict the parked terminals (teardownTerminalForViewChange),
  // so a warmed take starts on the hero terminal and ends on the dashboard instead.
  if (WITH_WARM) {
    const warmOrder = [...SESSIONS].reverse();
    await cardOpen(page, warmOrder[0]!).click();
    await waitLive(page);
    if (REMOTE_SESSION) {
      const remoteCard = remoteSidebarCard(page, REMOTE_SESSION);
      await remoteCard.waitFor({ timeout: 15000 });
      await remoteCard.click();
      await waitLive(page, 15000);
      await trustRemoteExtensions(page);
      await page.waitForTimeout(400);
    }
    for (const session of warmOrder) {
      await sidebarCard(page, session).click();
      await waitLive(page);
      await page.waitForTimeout(400);
    }
    scenes.push({ name: "warm-up done", at: Date.now() - started });
  }

  const capture = await startCapture(context, page, "frames");

  if (WITH_WARM) {
    await page.mouse.move(WIDTH * 0.6, HEIGHT * 0.55);
    pointer = { x: WIDTH * 0.6, y: HEIGHT * 0.55 };
    await page.waitForTimeout(1900);
    await checkpoint(page, "terminal");
  } else {
    await page.mouse.move(pointer.x, pointer.y);
    await page.waitForTimeout(1300);
    await checkpoint(page, "dashboard");

    // 1. open the hero session
    await glideClick(page, cardOpen(page, SESSIONS[0]!));
    await waitLive(page);
    await page.waitForTimeout(1700);
    await checkpoint(page, "terminal");
  }

  // 2. rapid switching through the sidebar (keep-mounted: no re-attach on the way back)
  const order = [...SESSIONS.slice(1), SESSIONS[0]!, SESSIONS[1]!];
  for (const session of order) {
    await glideClick(page, sidebarCard(page, session), 100);
    await waitLive(page, 4000);
    await page.waitForTimeout(520);
  }
  await checkpoint(page, "switched");

  // 3. resize: drag the workspace divider so the terminal reflows live
  const divider = page.locator("#workspace-context-divider:visible, #workspace-left-divider:visible").first();
  if (await divider.count()) {
    const box = await divider.boundingBox();
    if (box) {
      const y = box.y + box.height / 2;
      const x = box.x + box.width / 2;
      await glide(page, divider, { settle: 200 });
      await page.mouse.down();
      await page.mouse.move(x + 300, y, { steps: 34 });
      await page.waitForTimeout(600);
      await checkpoint(page, "divider");
      await page.mouse.move(x - 40, y, { steps: 34 });
      await page.waitForTimeout(300);
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.up();
      pointer = { x, y };
      await page.waitForTimeout(1300);
      await checkpoint(page, "divider-settled");
    }
  }

  // 4. a session on another machine
  if (REMOTE_SESSION) {
    const remoteCard = remoteSidebarCard(page, REMOTE_SESSION);
    await remoteCard.waitFor({ timeout: 10000 });
    await glideClick(page, remoteCard);
    await waitLive(page, 10000);
    await page.waitForTimeout(1900);
    await checkpoint(page, "remote");
  }

  // 5. back to the full-page dashboard
  await glideClick(page, page.locator("#sidebar-expand-btn"));
  await page.waitForTimeout(WITH_WARM ? 2200 : 1400);
  await checkpoint(page, "end");

  const framesDir = await capture.stop();
  await context.close();
  if (WITH_MOBILE) await recordMobile(browser);
  if (WITH_STILLS) await captureStills(browser);
  await browser.close();
  console.log(JSON.stringify({ scenes, frameCount: capture.count() }, null, 2));
  if (DRY) return;
  encode(framesDir, "wolfpack-usage-demo", GIF_WIDTH, MP4_WIDTH);
}

/** Lossless PNG on every screen change, timestamped by the compositor (CDP screencast). */
async function startCapture(context: BrowserContext, page: Page, dirName: string) {
  const framesDir = join(OUT_DIR, dirName);
  mkdirSync(framesDir, { recursive: true });
  const frames: Frame[] = [];
  const pendingWrites: Promise<unknown>[] = [];
  const cdp = await context.newCDPSession(page);
  if (!DRY) {
    cdp.on("Page.screencastFrame", (event) => {
      const file = join(framesDir, `f${String(frames.length).padStart(5, "0")}.png`);
      frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / 1000 });
      pendingWrites.push(Bun.write(file, Buffer.from(event.data, "base64")));
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  }
  return {
    count: () => frames.length,
    async stop(): Promise<string> {
      if (!DRY) await cdp.send("Page.stopScreencast").catch(() => undefined);
      await Promise.all(pendingWrites);
      if (!DRY) writeFileSync(join(framesDir, "frames.json"), JSON.stringify(frames));
      return framesDir;
    },
  };
}

const MOBILE_GIF_WIDTH = 440;
const MOBILE_MP4_WIDTH = 780;

/** Phone clip at 2x: dashboard → tap a session → live terminal → back → the next session → remote. */
async function recordMobile(browser: Browser): Promise<void> {
  const context = await demoContext(browser, MOBILE_STILL, true, 2);
  const page = await openDashboard(context);
  const remoteCard = REMOTE_SESSION ? page.locator(`.card-open[data-session="${REMOTE_SESSION}"]:not([data-machine=""])`).first() : undefined;
  if (remoteCard) {
    // pre-roll (not recorded): consent to the remote machine's extensions, then back to the dashboard
    await remoteCard.scrollIntoViewIfNeeded();
    await remoteCard.tap();
    await page.locator("canvas").first().waitFor({ timeout: 15000 });
    await trustRemoteExtensions(page);
    await page.locator("#back-btn:visible").first().tap();
    await page.locator(".card-open").first().waitFor({ timeout: 10000 });
    // the dashboard scrolls inside a container, not the window: reset every scrolled element
    await page.evaluate(() => { for (const element of [document.scrollingElement, ...document.querySelectorAll("*")]) if (element && element.scrollTop) element.scrollTop = 0; });
    await page.waitForTimeout(600);
  }
  const capture = await startCapture(context, page, "frames-mobile");
  await page.waitForTimeout(1300);
  await checkpoint(page, "m-dashboard");
  const tour = [...SESSIONS.slice(0, 2).map((name) => cardOpen(page, name))];
  if (remoteCard) tour.push(remoteCard);
  for (const [index, card] of tour.entries()) {
    await card.scrollIntoViewIfNeeded();
    await card.tap();
    await page.locator("canvas").first().waitFor({ timeout: 15000 });
    await waitLive(page, 10000).catch(() => undefined);
    await page.waitForTimeout(index === 0 ? 2200 : 1800);
    await checkpoint(page, `m-terminal-${index}`);
    await page.locator("#back-btn:visible").first().tap();
    await page.waitForTimeout(900);
  }
  await checkpoint(page, "m-end");
  const framesDir = await capture.stop();
  await context.close();
  if (!DRY) encode(framesDir, "wolfpack-mobile-demo", MOBILE_GIF_WIDTH, MOBILE_MP4_WIDTH);
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_STILL: Viewport = { width: 1440, height: 900 };
const MOBILE_STILL: Viewport = { width: 390, height: 844 };

/** Poster + showcase stills at the sizes the README and homepage already use. */
async function captureStills(browser: Browser): Promise<void> {
  const stillsDir = join(OUT_DIR, "stills");
  mkdirSync(stillsDir, { recursive: true });
  const hero = SESSIONS[0] ?? "";

  const desktop = await demoContext(browser, DESKTOP_STILL);
  const desktopPage = await openDashboard(desktop);
  await desktopPage.evaluate(() => document.getElementById("demo-cursor")?.remove());
  await desktopPage.waitForTimeout(900);
  await desktopPage.screenshot({ path: join(stillsDir, "desktop-sessions.png") });
  if (hero) {
    await cardOpen(desktopPage, hero).click();
    await waitLive(desktopPage);
    await desktopPage.waitForTimeout(1200);
    await desktopPage.screenshot({ path: join(stillsDir, "desktop-terminal.png") });
  }
  await desktop.close();

  const mobile = await demoContext(browser, MOBILE_STILL, true);
  const mobilePage = await openDashboard(mobile);
  await mobilePage.waitForTimeout(900);
  await mobilePage.screenshot({ path: join(stillsDir, "mobile-sessions.png") });
  if (hero) {
    await cardOpen(mobilePage, hero).click();
    await mobilePage.locator("canvas").first().waitFor({ timeout: 10000 });
    await mobilePage.waitForTimeout(1500);
    await mobilePage.screenshot({ path: join(stillsDir, "mobile-terminal.png") });
  }
  await mobile.close();
  console.log(JSON.stringify({ stills: readdirSync(stillsDir).map((name) => join(stillsDir, name)) }, null, 2));
}

function sh(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} exited ${result.exitCode}`);
}

/** ffmpeg concat list: each frame is held until the next one arrived. */
function writeConcatList(framesDir: string): string {
  const frames = JSON.parse(readFileSync(join(framesDir, "frames.json"), "utf8")) as Frame[];
  if (frames.length < 2) throw new Error("not enough frames");
  const lines: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const next = frames[index + 1];
    const duration = next ? Math.max(0.001, next.timestamp - frame.timestamp) : 1.5;
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1]!.file}'`);
  const list = join(framesDir, "concat.txt");
  writeFileSync(list, lines.join("\n") + "\n");
  return list;
}

function encode(framesDir: string, stem: string, gifWidth: number, mp4Width: number): void {
  const list = writeConcatList(framesDir);
  const mp4 = join(OUT_DIR, `${stem}.mp4`);
  const gif = join(OUT_DIR, `${stem}.gif`);
  const input = ["-f", "concat", "-safe", "0", "-i", list];
  sh([FFMPEG, "-loglevel", "error", "-y", ...input,
    "-vf", `fps=${MP4_FPS},scale=${mp4Width}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "slow", "-crf", "28",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  const palette = join(framesDir, "palette.png");
  sh([FFMPEG, "-loglevel", "error", "-y", ...input,
    "-vf", `fps=${GIF_FPS},scale=${gifWidth}:-2:flags=lanczos,palettegen=max_colors=64:stats_mode=diff`, palette]);
  sh([FFMPEG, "-loglevel", "error", "-y", ...input, "-i", palette,
    "-lavfi", `fps=${GIF_FPS},scale=${gifWidth}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, gif]);
  const hash = createHash("sha256").update(readFileSync(mp4)).digest("hex").slice(0, 16);
  console.log(JSON.stringify({
    mp4, gif,
    mp4Bytes: statSync(mp4).size, gifBytes: statSync(gif).size,
    siteName: `${stem}.${hash}.mp4`,
  }, null, 2));
}

if (ENCODE_ONLY) {
  const dir = resolve(ENCODE_ONLY);
  if (dir.endsWith("frames-mobile")) encode(dir, "wolfpack-mobile-demo", MOBILE_GIF_WIDTH, MOBILE_MP4_WIDTH);
  else encode(dir, "wolfpack-usage-demo", GIF_WIDTH, MP4_WIDTH);
} else if (MOBILE_ONLY) {
  const browser = await chromium.launch();
  await recordMobile(browser);
  await browser.close();
  console.log(JSON.stringify({ scenes }, null, 2));
} else if (STILLS_ONLY) {
  const browser = await chromium.launch();
  await captureStills(browser);
  await browser.close();
} else await run();
