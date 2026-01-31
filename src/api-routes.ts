import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getAllBridges,
  loadState,
  pauseBridge,
  resumeBridge,
  type BridgeEntry,
} from "./bridge-state.js";
import { tmuxListSessions, tmuxSendText, tmuxSessionExists } from "./tmux-io.js";
import * as outputWatcher from "./output-watcher.js";

interface PluginApi {
  registerHttpRoute(params: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void;
}

// Output ring buffer per tmux session for polling
const outputBuffers = new Map<string, string[]>();
const MAX_BUFFER_LINES = 200;

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MAX_BODY = 64 * 1024; // 64KB

function readBody(req: IncomingMessage): Promise<string> {
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

let stateDir: string | null = null;

export function setStateDir(dir: string): void {
  stateDir = dir;
}

export function registerApiRoutes(api: PluginApi): void {
  // GET /bridge/api/sessions — list tmux sessions with bridge state
  api.registerHttpRoute({
    path: "/bridge/api/sessions",
    handler: async (_req, res) => {
      if (!stateDir) return json(res, { error: "not ready" }, 503);

      const tmuxSessions = await tmuxListSessions();
      const bridges = getAllBridges(stateDir);
      const bridgeMap = new Map<string, { sessionKey: string; entry: BridgeEntry }>();
      for (const [sk, entry] of bridges) {
        bridgeMap.set(entry.tmuxSession, { sessionKey: sk, entry });
      }

      const sessions = tmuxSessions.map((name) => {
        const b = bridgeMap.get(name);
        return {
          name,
          status: b ? (b.entry.paused ? "paused" : "active") : "none",
          groupJid: b?.entry.groupJid ?? null,
        };
      });

      json(res, { sessions });
    },
  });

  // POST /bridge/api/send — send text to tmux session
  api.registerHttpRoute({
    path: "/bridge/api/send",
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const { session, text } = body as { session: string; text: string };
      if (!session || !text) return json(res, { error: "missing session or text" }, 400);
      if (!/^[a-zA-Z0-9._-]+$/.test(session)) return json(res, { error: "invalid session name" }, 400);
      if (!(await tmuxSessionExists(session))) return json(res, { error: "session not found" }, 404);
      await tmuxSendText(session, text);
      json(res, { ok: true });
    },
  });

  // POST /bridge/api/pause — pause a bridge
  api.registerHttpRoute({
    path: "/bridge/api/pause",
    handler: async (req, res) => {
      if (!stateDir) return json(res, { error: "not ready" }, 503);
      const body = JSON.parse(await readBody(req));
      const { session } = body as { session: string };
      if (!session) return json(res, { error: "missing session" }, 400);

      // Find the bridge by tmux session name
      const bridges = getAllBridges(stateDir);
      const match = bridges.find(([, e]) => e.tmuxSession === session);
      if (!match) return json(res, { error: "no bridge for session" }, 404);

      const [sessionKey] = match;
      pauseBridge(stateDir, sessionKey);
      await outputWatcher.removeSession(sessionKey);
      json(res, { ok: true });
    },
  });

  // POST /bridge/api/resume — resume a bridge
  api.registerHttpRoute({
    path: "/bridge/api/resume",
    handler: async (req, res) => {
      if (!stateDir) return json(res, { error: "not ready" }, 503);
      const body = JSON.parse(await readBody(req));
      const { session } = body as { session: string };
      if (!session) return json(res, { error: "missing session" }, 400);

      const bridges = getAllBridges(stateDir);
      // Also check paused bridges — getAllBridges only returns enabled
      // We need to load state directly for paused ones
      const state = loadState(stateDir);
      const match = Object.entries(state.bridges).find(([, e]) => e.tmuxSession === session && e.enabled);
      if (!match) return json(res, { error: "no bridge for session" }, 404);

      const [sessionKey, entry] = match;
      resumeBridge(stateDir, sessionKey);
      await outputWatcher.addSession(sessionKey, entry.tmuxSession, entry.groupJid);
      json(res, { ok: true });
    },
  });

  // GET /bridge/api/poll?session=foo&since=0 — poll output for a session
  api.registerHttpRoute({
    path: "/bridge/api/poll",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const session = url.searchParams.get("session");
      if (!session) return json(res, { error: "missing session param" }, 400);

      // Find session key by tmux session name
      const buf = findBufferByTmuxName(session);
      if (!buf) return json(res, { lines: [] });

      // Return and clear buffer
      const lines = buf.splice(0);
      json(res, { lines });
    },
  });
}

function findBufferByTmuxName(tmuxName: string): string[] | undefined {
  // Keys are session keys like "...:whatsapp:group:...", find by iterating
  // But for PWA we also want to support sessions without WhatsApp bridge
  // Use tmux session name as a secondary key
  for (const [key, buf] of outputBuffers) {
    if (key === tmuxName || key.includes(tmuxName)) return buf;
  }
  return undefined;
}

/** Also store output by tmux session name directly for PWA access */
export function onOutputByTmuxName(tmuxSession: string, text: string): void {
  let buf = outputBuffers.get(tmuxSession);
  if (!buf) {
    buf = [];
    outputBuffers.set(tmuxSession, buf);
  }
  buf.push(text);
  if (buf.length > MAX_BUFFER_LINES) {
    buf.splice(0, buf.length - MAX_BUFFER_LINES);
  }
}
