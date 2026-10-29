/**
 * Shared helpers for the demo recorder and encoder: fixture-server lifecycle,
 * the browser-side peer bridge, the drawn cursor, pointer gliding, CDP
 * screencast capture, the privacy guard and external tool lookup.
 */
import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { assertClean } from "./privacy-gate";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
export const DEMO_OUT = join(REPOSITORY_ROOT, ".demo-out");
export const MIN_FREE_DISK_BYTES = 4 * 1024 ** 3;

// ── arguments ────────────────────────────────────────────────────────────────

export function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key.slice(2), next);
      index += 1;
    } else {
      args.set(key.slice(2), "true");
    }
  }
  return args;
}

// ── external tools ───────────────────────────────────────────────────────────

export interface ToolSpec {
  readonly env: string;
  readonly name: string;
  readonly hint: string;
}

export const FFMPEG_TOOL: ToolSpec = {
  env: "WOLFPACK_FFMPEG",
  name: "ffmpeg >= 6 with libx264, libwebp, xfade and subtitles",
  hint: "install a static build under ~/.local/opt/ (see CONTRIBUTING.md, \"Site and demo media\") and export WOLFPACK_FFMPEG=~/.local/opt/ffmpeg/ffmpeg",
};

/** Resolves a tool strictly from its environment variable; no PATH guessing. */
export function resolveTool(spec: ToolSpec, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[spec.env];
  if (!value) throw new Error(`${spec.env} is not set: need ${spec.name}; ${spec.hint}`);
  if (!existsSync(value)) throw new Error(`${spec.env}=${value} does not exist: need ${spec.name}; ${spec.hint}`);
  return value;
}

/** ffprobe ships next to ffmpeg in every static build. */
export function ffprobeFor(ffmpeg: string): string {
  const candidate = join(dirname(ffmpeg), "ffprobe");
  if (!existsSync(candidate)) throw new Error(`no ffprobe next to ${ffmpeg}`);
  return candidate;
}

export function assertFreeDisk(path: string, minimum = MIN_FREE_DISK_BYTES): void {
  mkdirSync(path, { recursive: true });
  const stats = statfsSync(path);
  const free = stats.bavail * stats.bsize;
  if (free < minimum) {
    throw new Error(`only ${(free / 1024 ** 3).toFixed(1)} GB free under ${path}; need ${(minimum / 1024 ** 3).toFixed(0)} GB`);
  }
}

// ── fixture server ───────────────────────────────────────────────────────────

export interface FixtureServer {
  readonly machine: string;
  /** Temporary HOME the server owns; removed when it shuts down. */
  readonly home: string;
  /** Process id (and process group id) of the fixture server. */
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  /** Plays a transcript into a session; resolves when it finished. */
  play(session: string, transcript: string): Promise<void>;
  emit(session: string, text: string): void;
  close(): Promise<void>;
}

let playCounter = 0;

/**
 * The operator's environment minus every WOLFPACK_* setting (ports, tokens,
 * binary overrides, config paths), so a fixture server can never pick up the
 * operator's live configuration. WOLFPACK_TEST=1 is the only one set.
 */
export function fixtureServerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("WOLFPACK_")));
  return { ...clean, WOLFPACK_TEST: "1" };
}

/** Process groups of fixture servers this process started and has not closed yet. */
const liveFixtureGroups = new Set<number>();
let fixtureCleanupInstalled = false;

function signalFixtureGroups(signal: NodeJS.Signals): void {
  for (const pid of liveFixtureGroups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How long interrupted fixture servers get to remove their temporary HOME before SIGKILL. */
const FIXTURE_SHUTDOWN_GRACE_MS = 1000;

/**
 * Fixture servers run in their own process groups (so one kill reaches the
 * re-exec'd server too), which also means a terminal Ctrl-C never reaches
 * them. On SIGINT/SIGTERM/SIGHUP the groups get SIGTERM and up to a second to
 * exit (the bootstrap process deletes its temporary HOME on the way out);
 * SIGKILL is only the fallback, and the last resort on a plain exit.
 */
function installFixtureCleanup(): void {
  if (fixtureCleanupInstalled) return;
  fixtureCleanupInstalled = true;
  process.on("exit", () => signalFixtureGroups("SIGKILL"));
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      signalFixtureGroups("SIGTERM");
      const deadline = Date.now() + FIXTURE_SHUTDOWN_GRACE_MS;
      const poll = (): void => {
        if ([...liveFixtureGroups].some(groupAlive) && Date.now() < deadline) {
          setTimeout(poll, 20);
          return;
        }
        process.exit(code);
      };
      poll();
    });
  }
}

export function startFixtureServer(machine: string): Promise<FixtureServer> {
  installFixtureCleanup();
  return new Promise((resolveServer, reject) => {
    const child: ChildProcess = spawn("bun", [join(import.meta.dirname, "fixture-server.ts"), "--machine", machine], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: fixtureServerEnv(),
    });
    const groupId = child.pid;
    if (groupId !== undefined) liveFixtureGroups.add(groupId);
    const pending = new Map<string, () => void>();
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const lines = createInterface({ input: child.stdout! });
    const timeout = setTimeout(() => {
      stopGroup();
      reject(new Error(`fixture server ${machine} did not become ready:\n${stderr.join("")}`));
    }, 30_000);
    const stopGroup = (): void => {
      try {
        if (groupId !== undefined) process.kill(-groupId, "SIGTERM");
      } catch {
        // already gone
      }
    };
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    void exited.then(() => {
      if (groupId !== undefined) liveFixtureGroups.delete(groupId);
    });
    let home = "";
    lines.on("line", (line) => {
      if (line.startsWith("HOME:")) {
        home = line.slice("HOME:".length);
        return;
      }
      const ready = /^READY:(\d+)$/.exec(line);
      if (ready) {
        clearTimeout(timeout);
        const port = Number(ready[1]);
        resolveServer({
          machine,
          home,
          pid: groupId ?? -1,
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          play(session, transcript) {
            const id = `p${(playCounter += 1)}`;
            return new Promise<void>((done) => {
              pending.set(id, done);
              child.stdin!.write(`${JSON.stringify({ play: session, transcript, id })}\n`);
            });
          },
          emit(session, text) {
            child.stdin!.write(`${JSON.stringify({ emit: session, text })}\n`);
          },
          async close() {
            child.stdin!.end();
            stopGroup();
            await Promise.race([exited, Bun.sleep(3000)]);
            try {
              if (groupId !== undefined) process.kill(-groupId, "SIGKILL");
            } catch {
              // exited
            }
            if (groupId !== undefined) liveFixtureGroups.delete(groupId);
          },
        });
        return;
      }
      const done = /^DONE:(.+)$/.exec(line);
      if (done) {
        pending.get(done[1]!)?.();
        pending.delete(done[1]!);
        return;
      }
      if (line.startsWith("ERROR:")) console.error(`fixture ${machine}: ${line}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) reject(new Error(`fixture server ${machine} exited ${code}:\n${stderr.join("")}`));
    });
  });
}

/**
 * Marks every session's current runtime transition as reviewed, as a user who
 * has looked at the dashboard would have, so cards start without the
 * "changed since review" marker. Later transitions still surface normally.
 */
export async function acknowledgeAll(server: FixtureServer): Promise<number> {
  const response = await fetch(`${server.baseUrl}/api/sessions`);
  const { sessions } = await response.json() as {
    sessions: Array<{ identity?: { wolfpackSessionId?: string }; runtimeState?: { transitionSequence?: number; unseen?: boolean } }>;
  };
  let acknowledged = 0;
  for (const session of sessions) {
    const sessionId = session.identity?.wolfpackSessionId;
    const transitionSequence = session.runtimeState?.transitionSequence;
    if (!sessionId || !transitionSequence || !session.runtimeState?.unseen) continue;
    const ack = await fetch(`${server.baseUrl}/api/agent-runtime-state/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, transitionSequence }),
    });
    if (!ack.ok) throw new Error(`ack ${sessionId} on ${server.machine} failed: ${ack.status}`);
    acknowledged += 1;
  }
  return acknowledged;
}

// ── browser fixtures ─────────────────────────────────────────────────────────

export interface PeerBridge {
  readonly origin: string;
  readonly host: string;
  readonly tailnetNodeId: string;
  readonly server: FixtureServer;
}

/**
 * Makes a second fixture instance appear as a verified tailnet peer: the
 * candidate list names it, its HTTPS origin is fulfilled from the loopback
 * instance (with CORS for the home origin), and its terminal websocket is
 * bridged byte for byte. The app's own code paths are unchanged.
 */
export async function installPeer(context: BrowserContext, homeOrigin: string, peer: PeerBridge): Promise<void> {
  await context.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    json: { candidates: [{ hostname: peer.host, tailnetNodeId: peer.tailnetNodeId, origin: peer.origin, online: true }] },
  }));
  const cors = {
    "access-control-allow-origin": homeOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };
  await context.route(`${peer.origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    if (request.headers().accept === "text/event-stream") {
      // A buffered proxy cannot stream SSE; ask the client to stay away instead of polling.
      await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
      return;
    }
    const headers = { ...request.headers() };
    delete headers.origin;
    delete headers.referer;
    const response = await route.fetch({ url: `${peer.server.baseUrl}${url.pathname}${url.search}`, headers });
    await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
  const peerWs = new RegExp(`^wss://${peer.host.replace(/\./g, "\\.")}/ws/pty`);
  await context.routeWebSocket(peerWs, (socket) => bridgeWebSocket(socket, peer.server));
}

function bridgeWebSocket(socket: WebSocketRoute, server: FixtureServer): void {
  const url = new URL(socket.url());
  const upstream = new WebSocket(`ws://127.0.0.1:${server.port}${url.pathname}${url.search}`);
  upstream.binaryType = "arraybuffer";
  const queued: Array<string | Uint8Array<ArrayBuffer>> = [];
  upstream.onopen = () => {
    for (const message of queued.splice(0)) upstream.send(message);
  };
  upstream.onmessage = (event) => {
    socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
  };
  upstream.onclose = (event) => socket.close({ code: event.code === 1005 ? 1000 : event.code, reason: event.reason });
  socket.onMessage((message) => {
    const payload = typeof message === "string" ? message : Uint8Array.from(message);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else queued.push(payload);
  });
  socket.onClose(() => upstream.close());
}

/** Fixed browser wall clock so ages and timestamps are identical between takes. */
export async function freezeClock(context: BrowserContext, iso: string): Promise<void> {
  await context.addInitScript((time: number) => {
    const RealDate = Date;
    const offset = time - RealDate.now();
    class FixedDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date> | []) {
        if (args.length === 0) super(RealDate.now() + offset);
        else super(...(args as ConstructorParameters<typeof Date>));
      }
      static override now(): number {
        return RealDate.now() + offset;
      }
    }
    globalThis.Date = FixedDate as DateConstructor;
  }, Date.parse(iso));
}

// ── pointer and cursor ───────────────────────────────────────────────────────

export const CURSOR_SCRIPT = `
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
    // Chromium reports a synthetic move to (0,0) before any real input; do not draw it.
    if (cursor.style.opacity === "0" && event.clientX === 0 && event.clientY === 0) return;
    cursor.style.opacity = "1";
    cursor.style.left = event.clientX + "px";
    cursor.style.top = event.clientY + "px";
  }, true);
  window.addEventListener("mousedown", () => cursor.classList.add("press"), true);
  window.addEventListener("mouseup", () => cursor.classList.remove("press"), true);
})();
`;

/** Tracks the last pointer position so glides start where the cursor is. */
export class Pointer {
  constructor(private readonly page: Page, private position = { x: 0, y: 0 }) {}

  async moveTo(x: number, y: number, steps = 12): Promise<void> {
    await this.page.mouse.move(x, y, { steps });
    this.position = { x, y };
  }

  async glide(target: Locator, settle = 180): Promise<{ x: number; y: number }> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`no bounding box for ${target}`);
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const distance = Math.hypot(to.x - this.position.x, to.y - this.position.y);
    await this.moveTo(to.x, to.y, Math.max(8, Math.min(28, Math.round(distance / 30))));
    await this.page.waitForTimeout(settle);
    return to;
  }

  async click(target: Locator, settle = 180): Promise<void> {
    await this.glide(target, settle);
    await this.page.mouse.down();
    await this.page.waitForTimeout(70);
    await this.page.mouse.up();
  }

  async drag(target: Locator, dx: number, dy = 0): Promise<void> {
    const from = await this.glide(target, 200);
    await this.page.mouse.down();
    await this.moveTo(from.x + dx, from.y + dy, 34);
    await this.page.mouse.up();
  }
}

export async function waitLive(page: Page, timeout = 10_000): Promise<void> {
  await page.locator("#desktop-terminal-container").waitFor({ state: "visible", timeout });
  await page.locator('#desktop-terminal-container[data-terminal-load-state="live"]').waitFor({ state: "attached", timeout });
}

// ── capture ──────────────────────────────────────────────────────────────────

export interface Frame {
  /** File name inside the frames directory (relative, so no local paths leak into frames.json). */
  readonly file: string;
  readonly timestamp: number;
}

export interface Capture {
  count(): number;
  stop(): Promise<string>;
}

/**
 * Lossless PNG on every screen change, timestamped by the compositor (CDP
 * screencast). The screencast emits CSS pixels unless the browser itself was
 * launched with a matching `--force-device-scale-factor` (see browserArgs).
 */
export async function startCapture(context: BrowserContext, page: Page, framesDir: string): Promise<Capture> {
  mkdirSync(framesDir, { recursive: true });
  const frames: Frame[] = [];
  const writes: Promise<unknown>[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", (event) => {
    const file = `f${String(frames.length).padStart(5, "0")}.png`;
    frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(Bun.write(join(framesDir, file), Buffer.from(event.data, "base64")));
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    count: () => frames.length,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await Promise.all(writes);
      // Frames only arrive on change; record how long the last picture stayed up.
      const last = frames.at(-1);
      if (last) frames.push({ file: last.file, timestamp: Math.max(last.timestamp, Date.now() / 1000) });
      writeFileSync(join(framesDir, "frames.json"), JSON.stringify(frames));
      await cdp.detach().catch(() => undefined);
      return framesDir;
    },
  };
}

/** Chromium flags so screencast frames come out at `scale` device pixels per CSS pixel. */
export function browserArgs(scale: number): string[] {
  return scale === 1 ? [] : [`--force-device-scale-factor=${scale}`];
}

/** Fails the run when the rendered page contains any forbidden string. */
export async function guardPage(page: Page, where: string, forbidden: readonly string[]): Promise<void> {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  assertClean(html, where, forbidden);
}
