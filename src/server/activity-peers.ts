import { loadConfig, remoteUrl } from "../config.js";
import { issueJwt } from "../jwt-issue.js";
import { classifyMachineHandshake } from "../tailnet-machine-contract.js";
import { readPeerResponse, withPeerAbort } from "../task-relay/peer-response.js";
import { readRelayPeerTopology } from "./tailscale-status.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("server");

export const PEER_TIMEOUT_MS = 4000;
const HANDSHAKE_TTL_MS = 10 * 60_000;
export interface ActivityPeer { origin: string; installationId: string; name: string; get<T>(path: string, maxBytes: number): Promise<T> }

/**
 * Test-only transport seam (WOLFPACK_TEST, like WOLFPACK_TAILSCALE_STATUS_JSON):
 * maps a canonical tailnet origin to a local URL so private servers can act as peers.
 * Identity is still verified against the canonical origin by the handshake.
 */
export function activityPeerTransportUrl(origin: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env.WOLFPACK_TEST ? env.WOLFPACK_FOCUS_PEER_URLS_JSON : undefined;
  if (!raw) return origin;
  try { const map = JSON.parse(raw) as Record<string, unknown>; return typeof map[origin] === "string" ? map[origin] as string : origin; } catch { return origin; }
}

/** Same authenticated peer path as the task relay transport: owner bearer, no redirects, bounded bodies. */
async function peerGet<T>(origin: string, path: string, maxBytes: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    return await withPeerAbort(controller.signal, async () => {
      const headers = new Headers();
      const jwt = issueJwt();
      if (jwt) headers.set("authorization", `Bearer ${jwt}`);
      const response = await fetch(activityPeerTransportUrl(origin) + path, { headers, redirect: "error", cache: "no-store", signal: controller.signal });
      const text = await readPeerResponse(response, controller.signal, maxBytes);
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { const body = JSON.parse(text) as { error?: unknown }; if (typeof body.error === "string") message = body.error; } catch { /* non-json error */ }
        throw new Error(response.status === 404 ? `peer has no activity journal (${message})` : message);
      }
      return JSON.parse(text) as T;
    });
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Last topology failure, so a persistent one warns once per change, not every tick. */
let topologyError: string | undefined;
const handshakes = new Map<string, { nodeId: string; installationId: string; name: string; expiresAt: number }>();
/** Online verified tailnet peers. A missing tailnet is a single-machine setup, not an error. */
export async function discoverActivityPeers(now = Date.now()): Promise<{ peers: ActivityPeer[]; failures: { origin: string; error: string }[] }> {
  const config = loadConfig();
  let topology;
  try { topology = await readRelayPeerTopology(config ? remoteUrl(config) ?? undefined : undefined); topologyError = undefined; }
  catch (error) {
    const message = errMsg(error);
    if (message !== topologyError) log.warn("activity peers unavailable: tailnet topology unreadable; using this machine only", { error: message });
    topologyError = message;
    return { peers: [], failures: [] };
  }
  const peers: ActivityPeer[] = [];
  const failures: { origin: string; error: string }[] = [];
  await Promise.all([...topology.peers].map(async ([origin, nodeId]) => {
    try {
      let known = handshakes.get(origin);
      if (!known || known.nodeId !== nodeId || known.expiresAt < now) {
        const classification = classifyMachineHandshake({ origin, tailnetNodeId: nodeId, hostname: new URL(origin).hostname, online: true }, await peerGet(origin, "/api/machine", 32 * 1024));
        if (classification.kind !== "ready") throw new Error(`peer machine ${classification.kind}`);
        known = { nodeId, installationId: classification.handshake.machine.installationId, name: classification.handshake.machine.displayName, expiresAt: now + HANDSHAKE_TTL_MS };
        handshakes.set(origin, known);
      }
      peers.push({ origin, installationId: known.installationId, name: known.name, get: (path, maxBytes) => peerGet(origin, path, maxBytes) });
    } catch (error) { failures.push({ origin, error: error instanceof Error ? error.message : String(error) }); }
  }));
  return { peers, failures };
}
