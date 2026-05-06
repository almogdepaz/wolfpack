/**
 * HTTP utilities — session helpers, JSON response, body parsing, file serving, peer discovery.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { assets } from "../public-assets.js";
import { exec } from "./shell.js";
import { getBackend } from "./backend.js";
import { createLogger } from "../log.js";

const log = createLogger("http");

// ── Token-bucket rate limiter ──

/** Single token-bucket instance (tokens refill at `rate` per second). */
export function createRateLimiter(rate: number) {
  let tokens = rate;
  let last = Date.now();
  return {
    allow(): boolean {
      const now = Date.now();
      tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) return false;
      tokens--;
      return true;
    },
  };
}

type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * Per-IP rate limiter map. Creates a limiter on first request from each IP.
 * Evicts stale entries every `evictIntervalMs` to prevent unbounded growth.
 */
const MAX_IP_ENTRIES = 10_000;

export function createPerIpRateLimiter(rate: number, evictIntervalMs = 60_000) {
  const map = new Map<string, { rl: RateLimiter; lastSeen: number }>();

  const evict = setInterval(() => {
    const cutoff = Date.now() - evictIntervalMs;
    for (const [ip, entry] of map) {
      if (entry.lastSeen < cutoff) map.delete(ip);
    }
  }, evictIntervalMs).unref();

  return {
    allow(ip: string): boolean {
      let entry = map.get(ip);
      if (!entry) {
        // Cap at MAX_IP_ENTRIES — evict insertion-order oldest (O(1) via Map key order)
        if (map.size >= MAX_IP_ENTRIES) {
          map.delete(map.keys().next().value as string);
        }
        entry = { rl: createRateLimiter(rate), lastSeen: Date.now() };
        map.set(ip, entry);
      }
      entry.lastSeen = Date.now();
      return entry.rl.allow();
    },
    /** Exposed for testing. */
    _map: map,
    _evictTimer: evict,
  };
}

// ── Session helpers ──

export async function uniqueSessionName(base: string): Promise<string> {
  // tmux silently replaces dots with underscores in session names — do it upfront
  // so the name we return matches what tmux actually creates
  base = base.replace(/\./g, "_");
  const sessions = await getBackend().list();
  if (!sessions.includes(base)) return base;
  let i = 2;
  while (sessions.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export async function isAllowedSession(session: string): Promise<boolean> {
  const allowed = await getBackend().list();
  return allowed.includes(session);
}

// ── HTTP helpers ──

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const PUBLIC_API_PATHS = new Set(["/api/info"]);

export function shouldAuthenticateApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") && !PUBLIC_API_PATHS.has(pathname);
}

export function writeUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="wolfpack"',
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── Constants ──
const MAX_BODY = 64 * 1024;
const PEER_PROBE_TIMEOUT_MS = 3_000;
const TAILSCALE_MAX_BUFFER = 10 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function parseBody<T = any>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch { /* expected: client sent malformed JSON */
    json(res, { error: "invalid JSON body" }, 400);
    return null;
  }
}

/** Generate a cryptographically random base64 nonce for CSP. */
export function generateCspNonce(): string {
  return randomBytes(16).toString("base64");
}

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' wss: https:",
    "img-src 'self' data:",
  ].join("; ");
}

export function serveFile(res: ServerResponse, filename: string): void {
  const asset = assets.get(filename);
  if (!asset) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.mime,
    "Cache-Control": "no-cache",
  };
  if (asset.mime === "text/html") {
    const nonce = generateCspNonce();
    headers["Content-Security-Policy"] = buildCsp(nonce);
    // Inject nonce into all <script> tags
    const html = (typeof asset.content === "string" ? asset.content : asset.content.toString())
      .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    res.writeHead(200, headers);
    res.end(html);
    return;
  }
  res.writeHead(200, headers);
  res.end(asset.content);
}

// ── Peer discovery ──

/** Strip C0/C1 control characters and truncate to 64 chars. */
export function sanitizePeerName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 64);
}

// Cached peer list for server-side aggregation (populated by /api/discover)
export let cachedPeers: { url: string; name: string }[] = [];

// Must invoke via login shell: the macOS App Store Tailscale CLI
// (/Applications/Tailscale.app/Contents/MacOS/Tailscale) relies on the user's
// session env to reach the GUI-hosted daemon. Under launchd's stripped env a
// direct execFile prints "The Tailscale GUI failed to start..." to stdout
// (exit 0), which then fails JSON.parse. `/bin/sh -l -c` sources the user's
// login profile so the bridge resolves. Revert warning: do NOT "simplify" to
// a direct execFile — that silently breaks discovery on App Store installs.
export function buildTailscaleStatusArgv(tsBin: string): { cmd: string; args: string[] } {
  return { cmd: "/bin/sh", args: ["-l", "-c", `"${tsBin}" status --json`] };
}

export async function discoverPeers(): Promise<{ peers: any[]; error?: string }> {
  const tsBin = [
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((p) => { try { execFileSync("test", ["-x", p]); return true; } catch { /* probe: binary not found at this path */ return false; } });
  if (!tsBin) return { peers: [], error: "tailscale not found" };

  try {
    const { cmd, args } = buildTailscaleStatusArgv(tsBin);
    const { stdout } = await exec(
      cmd, args,
      { maxBuffer: TAILSCALE_MAX_BUFFER },
    );
    const status = JSON.parse(stdout);
    const self = status.Self?.DNSName?.replace(/\.$/, "");
    const peers: { hostname: string; url: string }[] = [];
    for (const [, peer] of Object.entries(status.Peer || {}) as [string, any][]) {
      if (!peer.Online) continue;
      const dns = peer.DNSName?.replace(/\.$/, "");
      if (!dns || dns === self) continue;
      peers.push({ hostname: dns, url: `https://${dns}` });
    }

    const results = await Promise.all(
      peers.map(async (p) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PEER_PROBE_TIMEOUT_MS);
          const r = await fetch(p.url + "/api/info", { signal: ctrl.signal });
          clearTimeout(timer);
          const info = await r.json();
          const sanitized = sanitizePeerName(info.name);
          return { ...p, name: sanitized || p.hostname, version: sanitizePeerName(info.version), wolfpack: true as const };
        } catch { /* expected: peer unreachable or not running wolfpack */
          return { ...p, name: p.hostname, version: undefined, wolfpack: false as const };
        }
      }),
    );
    const wolfpackPeers = results.filter((r): r is Extract<typeof r, { wolfpack: true }> => r.wolfpack);
    cachedPeers = wolfpackPeers.map(p => ({ url: p.url, name: p.name }));
    return { peers: wolfpackPeers };
  } catch (e: any) {
    log.error("discover error", { error: e?.message || String(e) });
    return { peers: [], error: "failed to query tailscale" };
  }
}
