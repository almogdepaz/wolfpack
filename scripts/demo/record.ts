#!/usr/bin/env bun
/**
 * Records the site/README/promo demo scenes against fixture servers (synthetic
 * sessions, real app, real websocket relay, real ghostty renderer).
 *
 *   bun run demo:record [--scene desktop|mobile|cli|cards|all] [--dry] [--out .demo-out] [--dpr 1] [--forbid a,b]
 *
 * --dry          checkpoint screenshots only (no screencast frames)
 * --scene        one scene or "all" (default)
 * --out          output root (default .demo-out); each scene writes <out>/<scene>/
 * --dpr          device scale factor for the desktop and card scenes (mobile is always 2);
 *                the browser is launched with a matching --force-device-scale-factor so
 *                screencast frames are device pixels, not CSS pixels
 * --forbid       extra strings the privacy gate must never see (comma separated)
 *
 * Every scene writes <out>/<scene>/checkpoints/NN-<name>.png and scene.json
 * (checkpoint timeline, frame count). Without --dry it also writes
 * <out>/<scene>/frames/ (CDP screencast PNGs + frames.json) for demo:encode.
 * The page HTML is checked by the privacy gate at every checkpoint and at
 * screencast start/stop; a hit aborts the run.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFixtures, type DemoFixtures } from "./fixtures";
import {
  CURSOR_SCRIPT,
  DEMO_OUT,
  acknowledgeAll,
  Pointer,
  assertFreeDisk,
  browserArgs,
  freezeClock,
  guardPage,
  installPeer,
  parseArgs,
  startCapture,
  startFixtureServer,
  waitLive,
  type Capture,
  type FixtureServer,
} from "./lib";
import { forbiddenStrings, parseForbidList } from "./privacy-gate";

export const SCENES = ["desktop", "mobile", "cli", "cards"] as const;
type SceneName = typeof SCENES[number];

const DESKTOP_VIEWPORT = { width: 1600, height: 1000 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const MOBILE_SCALE = 2;
const CARD_VIEWPORT = { width: 1920, height: 1080 } as const;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CARDS_DIR = join(import.meta.dirname, "cards");
const CARD_ORDER = ["title", "privacy", "install", "end"] as const;

interface Options {
  readonly dry: boolean;
  readonly out: string;
  readonly dpr: number;
  readonly forbidden: readonly string[];
}

interface Checkpoint {
  readonly name: string;
  readonly atMs: number;
  readonly file: string;
  /** Screencast segment and frame count when the checkpoint was taken (encode cuts by these). */
  readonly segment: string | undefined;
  readonly frame: number | undefined;
}

/** One scene's output directory, checkpoint log and optional screencast. */
class SceneRecorder {
  readonly dir: string;
  private readonly checkpoints: Checkpoint[] = [];
  private readonly started = Date.now();
  private capture: Capture | undefined;
  private segment = 0;
  private segmentDir = "frames";

  constructor(readonly scene: string, private readonly options: Options) {
    this.dir = join(options.out, scene);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, "checkpoints"), { recursive: true });
  }

  async checkpoint(page: Page, name: string): Promise<void> {
    await guardPage(page, `${this.scene}/${name}`, this.options.forbidden);
    const file = join(this.dir, "checkpoints", `${String(this.checkpoints.length + 1).padStart(2, "0")}-${name}.png`);
    const frame = this.capture?.count();
    await page.screenshot({ path: file, animations: "allow", caret: "initial" });
    this.checkpoints.push({ name, atMs: Date.now() - this.started, file, segment: this.capture ? this.segmentDir : undefined, frame });
  }

  /** Starts a screencast segment (none in --dry). Cards record one segment per card. */
  async startFrames(context: BrowserContext, page: Page, label = ""): Promise<void> {
    if (this.options.dry) return;
    await guardPage(page, `${this.scene}/screencast-start`, this.options.forbidden);
    this.segment += 1;
    this.segmentDir = label ? `frames-${label}` : "frames";
    this.capture = await startCapture(context, page, join(this.dir, this.segmentDir));
  }

  async stopFrames(page: Page): Promise<number> {
    if (!this.capture) return 0;
    await guardPage(page, `${this.scene}/screencast-stop`, this.options.forbidden);
    const count = this.capture.count();
    await this.capture.stop();
    this.capture = undefined;
    this.frameCounts.push(count);
    return count;
  }

  private readonly frameCounts: number[] = [];

  finish(extra: Record<string, unknown> = {}): void {
    const summary = {
      scene: this.scene,
      dry: this.options.dry,
      durationMs: Date.now() - this.started,
      frameCount: this.frameCounts.reduce((total, count) => total + count, 0),
      segments: this.segment,
      checkpoints: this.checkpoints.map((checkpoint) => ({ ...checkpoint, file: checkpoint.file.slice(this.dir.length + 1) })),
      ...extra,
    };
    writeFileSync(join(this.dir, "scene.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ scene: this.scene, frameCount: summary.frameCount, checkpoints: summary.checkpoints.length }));
  }
}

interface Stage {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly home: FixtureServer;
  readonly peer: FixtureServer;
  readonly fixtures: DemoFixtures;
}

async function openStage(browser: Browser, options: { viewport: { width: number; height: number }; dpr: number; mobile: boolean }): Promise<Stage> {
  const fixtures = loadFixtures();
  // Sequential on purpose: "Needs you" sorts by when each server first observed the
  // waiting state, so the workstation must be observed before the MacBook every take.
  const home = await startFixtureServer("workstation");
  await acknowledgeAll(home);
  const peer = await startFixtureServer("macbook");
  await acknowledgeAll(peer);
  const peerMachine = fixtures.machines.macbook!;
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.dpr,
    colorScheme: "dark",
    timezoneId: "UTC",
    locale: "en-US",
    ...(options.mobile ? { isMobile: true, hasTouch: true, userAgent: IPHONE_UA } : {}),
  });
  await freezeClock(context, fixtures.clock);
  await installPeer(context, home.baseUrl, {
    origin: `https://${peerMachine.host}`,
    host: peerMachine.host,
    tailnetNodeId: peerMachine.tailnetNodeId,
    server: peer,
  });
  if (!options.mobile) await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  await page.goto(`${home.baseUrl}/`);
  await page.locator(".card-open").first().waitFor({ timeout: 20_000 });
  await page.locator(`.card-open[data-session="mobile-app"]:not([data-machine=""])`).first().waitFor({ state: "attached", timeout: 20_000 });
  return { page, context, home, peer, fixtures };
}

async function closeStage(stage: Stage): Promise<void> {
  await stage.context.unrouteAll({ behavior: "ignoreErrors" });
  await stage.context.close();
  await Promise.all([stage.home.close(), stage.peer.close()]);
}

function localCard(page: Page, scope: string, session: string): Locator {
  return page.locator(`${scope} .card-open[data-session="${session}"][data-machine=""]`).first();
}

function remoteCard(page: Page, scope: string, session: string): Locator {
  return page.locator(`${scope} .card-open[data-session="${session}"]:not([data-machine=""])`).first();
}

/** Remote extension consent lives in page memory and names the peer origin; accept it off camera. */
async function trustRemoteExtensions(page: Page): Promise<void> {
  const prompt = page.locator('form.extension-access-prompt[aria-label="Trust selected machine browser code?"]');
  if (await prompt.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    await prompt.getByRole("button", { name: "Trust this inventory" }).click();
    await prompt.waitFor({ state: "detached", timeout: 5000 });
  }
}

/** S1–S4: dashboard, answer a needs-input banner, switch/resize/grid, delegation tree. */
async function recordDesktop(browser: Browser, options: Options): Promise<void> {
  const recorder = new SceneRecorder("desktop", options);
  const stage = await openStage(browser, { viewport: DESKTOP_VIEWPORT, dpr: options.dpr, mobile: false });
  const { page, context, home } = stage;
  // Start on empty space between the summary and the filters, so no card shows a hover state.
  const rest = { x: DESKTOP_VIEWPORT.width * 0.5, y: 120 };
  const pointer = new Pointer(page, rest);
  try {
    await page.locator("#session-list .needs-you .card").first().waitFor();
    await page.waitForTimeout(1200);
    await recorder.startFrames(context, page);
    await pointer.moveTo(rest.x, rest.y, 1);
    await page.waitForTimeout(900);
    await recorder.checkpoint(page, "s1-dashboard");
    await pointer.glide(page.locator("#session-list .needs-you .card").first(), 700);

    // S2: open the session that needs input and answer it from the banner.
    await pointer.click(localCard(page, "#session-list .needs-you", "api-gateway"));
    await waitLive(page);
    await page.locator("#needs-input-banner:not([hidden])").waitFor();
    await page.waitForTimeout(1100);
    await recorder.checkpoint(page, "s2-banner");
    await pointer.click(page.locator('[data-reply-key="y"]'), 450);
    await page.locator("#needs-input-banner").waitFor({ state: "hidden", timeout: 10_000 });
    await page.waitForTimeout(3600);
    await recorder.checkpoint(page, "s2-answered");

    // S3: instant switching through the sidebar, live resize, then a grid.
    for (const session of ["billing-service", "docs-site", "web-dashboard"]) {
      await pointer.click(localCard(page, "#sidebar-session-list", session), 120);
      await waitLive(page, 5000);
      await page.waitForTimeout(650);
    }
    await recorder.checkpoint(page, "s3-switched");
    const divider = page.locator("#workspace-context-divider:visible, #workspace-left-divider:visible").first();
    if (await divider.count()) {
      await pointer.drag(divider, 260);
      await page.waitForTimeout(700);
      await recorder.checkpoint(page, "s3-resized");
      await pointer.drag(divider, -260);
      await page.waitForTimeout(500);
    }
    for (const session of ["billing-service", "docs-site"]) {
      await pointer.click(page.locator(`#sidebar-session-list .grid-btn[data-session="${session}"][data-machine=""]`), 200);
      await page.waitForTimeout(900);
    }
    await page.locator("#desktop-grid-container .grid-cell").nth(2).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await recorder.checkpoint(page, "s3-grid");

    // S4: the answered agent spawned two children; open its delegation tree.
    const toggle = page.locator('#sidebar-session-list [data-action="delegation-toggle"]').first();
    await toggle.waitFor({ timeout: 15_000 });
    await pointer.click(toggle, 300);
    await page.waitForTimeout(700);
    await pointer.click(localCard(page, "#sidebar-session-list", "api-gateway"), 200);
    await page.locator("#delegation-grid-container .delegation-grid-cell").nth(2).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await recorder.checkpoint(page, "s4-delegation");
    await Promise.all([
      home.play("201-load-test", "201-load-test-done.ans"),
      home.play("api-gateway", "api-gateway-child-report.ans"),
    ]);
    await page.waitForTimeout(1800);
    await recorder.checkpoint(page, "s4-reported");
    await recorder.stopFrames(page);
    recorder.finish();
  } finally {
    await closeStage(stage);
  }
}

/** S5: phone dashboard → Needs you → terminal → y + Enter → Back → a MacBook session. */
async function recordMobile(browser: Browser, options: Options): Promise<void> {
  const recorder = new SceneRecorder("mobile", options);
  const stage = await openStage(browser, { viewport: MOBILE_VIEWPORT, dpr: MOBILE_SCALE, mobile: true });
  const { page, context } = stage;
  try {
    // Pre-roll (not recorded): consent to the peer's extensions, then return to the top.
    const peerCard = remoteCard(page, "#session-list", "mobile-app");
    await peerCard.scrollIntoViewIfNeeded();
    await peerCard.tap();
    await page.locator("canvas").first().waitFor({ timeout: 15_000 });
    await trustRemoteExtensions(page);
    await page.locator("#back-btn:visible").first().tap();
    await page.locator(".card-open").first().waitFor();
    await page.evaluate(() => {
      for (const element of [document.scrollingElement, ...document.querySelectorAll("*")]) if (element && element.scrollTop) element.scrollTop = 0;
    });
    await page.waitForTimeout(800);

    await recorder.startFrames(context, page);
    await page.waitForTimeout(1300);
    await recorder.checkpoint(page, "s5-dashboard");
    await localCard(page, "#session-list .needs-you", "api-gateway").tap();
    await page.locator("canvas").first().waitFor({ timeout: 15_000 });
    await waitLive(page).catch(() => undefined);
    await page.waitForTimeout(1600);
    await recorder.checkpoint(page, "s5-terminal");
    await page.locator("#kb-open-btn").tap();
    await page.waitForTimeout(500);
    await page.keyboard.type("y", { delay: 120 });
    await page.waitForTimeout(250);
    await page.locator('#kb-accessory .kb-key[data-key="Enter"]').tap();
    await page.waitForTimeout(3600);
    await recorder.checkpoint(page, "s5-answered");
    await page.locator("#back-btn:visible").first().tap();
    await page.waitForTimeout(900);
    const peer = remoteCard(page, "#session-list", "mobile-app");
    await peer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await recorder.checkpoint(page, "s5-machines");
    await peer.tap();
    await page.locator("canvas").first().waitFor({ timeout: 15_000 });
    await waitLive(page).catch(() => undefined);
    await page.waitForTimeout(1800);
    await recorder.checkpoint(page, "s5-remote");
    await recorder.stopFrames(page);
    recorder.finish();
  } finally {
    await closeStage(stage);
  }
}

async function openCard(browser: Browser, options: Options, card: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: CARD_VIEWPORT, deviceScaleFactor: options.dpr, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.goto(pathToFileURL(join(CARDS_DIR, `${card}.html`)).href, { waitUntil: "load" });
  return { context, page };
}

async function playCard(browser: Browser, options: Options, recorder: SceneRecorder, card: string): Promise<void> {
  const { context, page } = await openCard(browser, options, card);
  try {
    await recorder.startFrames(context, page, card);
    await page.locator("body[data-done]").waitFor({ timeout: 30_000 });
    await recorder.checkpoint(page, card);
    await recorder.stopFrames(page);
  } finally {
    await context.close();
  }
}

/** S6: the CLI card (spawn, events, --machine). */
async function recordCli(browser: Browser, options: Options): Promise<void> {
  const recorder = new SceneRecorder("cli", options);
  await playCard(browser, options, recorder, "cli");
  recorder.finish();
}

/** S0, S7, S8 and the end card. */
async function recordCards(browser: Browser, options: Options): Promise<void> {
  const recorder = new SceneRecorder("cards", options);
  for (const card of CARD_ORDER) await playCard(browser, options, recorder, card);
  recorder.finish({ cards: CARD_ORDER });
}

/** Device scale each scene renders at; the browser is launched to match (see browserArgs). */
function sceneScale(scene: SceneName, options: Options): number {
  return scene === "mobile" ? MOBILE_SCALE : options.dpr;
}

const RECORDERS: Record<SceneName, (browser: Browser, options: Options) => Promise<void>> = {
  desktop: recordDesktop,
  mobile: recordMobile,
  cli: recordCli,
  cards: recordCards,
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  for (const key of args.keys()) {
    if (!["scene", "dry", "out", "dpr", "forbid"].includes(key)) throw new Error(`unknown flag --${key}`);
  }
  const sceneArg = args.get("scene") ?? "all";
  const scenes = sceneArg === "all" ? [...SCENES] : sceneArg.split(",");
  for (const scene of scenes) {
    if (!SCENES.includes(scene as SceneName)) throw new Error(`unknown scene ${scene}; expected ${SCENES.join(", ")} or all`);
  }
  const options: Options = {
    dry: args.get("dry") === "true",
    out: resolve(args.get("out") ?? DEMO_OUT),
    dpr: Number(args.get("dpr") ?? 1),
    forbidden: forbiddenStrings(parseForbidList(args.get("forbid"))),
  };
  if (!(options.dpr >= 1 && options.dpr <= 3)) throw new Error("--dpr must be between 1 and 3");
  assertFreeDisk(options.out);
  for (const scene of scenes as SceneName[]) {
    const browser = await chromium.launch({ args: browserArgs(sceneScale(scene, options)) });
    try {
      await RECORDERS[scene](browser, options);
    } finally {
      await browser.close();
    }
  }
}
