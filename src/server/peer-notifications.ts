import { loadConfig, remoteUrl } from "../cli/config.ts";
import { issueJwt } from "../cli/api.ts";
import { classifyMachineHandshake } from "../tailnet-machine-contract.ts";
import { stableMachineIdentity } from "../tailnet-peer-registry.ts";
import { isQuietAlertFact } from "../quiet-alert-policy.ts";
import { readPeerResponse, withPeerAbort } from "../task-relay/peer-response.ts";
import type { RelayPeerTopology } from "../task-relay/peer-topology.ts";
import { createLogger, errMsg } from "../log.ts";
import { readRelayPeerTopology } from "./http.ts";
import type { NotificationMachine } from "./push.ts";
import type { QuietAlertFact } from "../quiet-alert-policy.ts";

const log = createLogger("peer-notifications");
interface PeerSession {
  readonly name: string;
  readonly identity: { readonly wolfpackSessionId: string };
  readonly quietAlert?: QuietAlertFact;
}
interface PeerObservation {
  readonly machine: NotificationMachine;
  readonly sessions: readonly PeerSession[];
}
interface Options {
  readonly topology: () => Promise<RelayPeerTopology>;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly jwt?: () => string | null;
  readonly timeoutMs?: number;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only locally trusted, online canonical peers can supply notification facts.
 * No policy reduction here: older peers work if they expose quietAlert facts. */
export async function observePeerNotifications(options?: Options): Promise<readonly PeerObservation[]> {
  const config = options ? null : loadConfig();
  const configuredOrigin = config ? remoteUrl(config) ?? undefined : undefined;
  const topology = options?.topology ?? (() => readRelayPeerTopology(configuredOrigin));
  let own: RelayPeerTopology;
  try { own = await topology(); }
  catch (error: unknown) { log.debug("peer notification topology unavailable", { error: errMsg(error) }); return []; }
  const peers = [...own.peers];
  const observations: PeerObservation[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, peers.length) }, async () => {
    while (next < peers.length) {
      const [origin, nodeId] = peers[next++]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 4_000);
      try {
        const observation = await withPeerAbort(controller.signal, async () => {
          const headers = new Headers();
          const jwt = (options?.jwt ?? issueJwt)();
          if (jwt) headers.set("authorization", `Bearer ${jwt}`);
          const request = async (path: string, limit: number): Promise<unknown> => {
            const response = await (options?.fetch ?? fetch)(origin + path, { headers, redirect: "error", cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(`peer request failed: ${response.status}`);
            return JSON.parse(await readPeerResponse(response, controller.signal, limit));
          };
          const classification = classifyMachineHandshake({ origin, tailnetNodeId: nodeId, hostname: new URL(origin).hostname, online: true }, await request("/api/machine", 32 * 1024));
          if (classification.kind !== "ready") throw new Error("peer machine not ready");
          const body = await request("/api/sessions", 1024 * 1024);
          if (!record(body) || !Array.isArray(body.sessions) || body.sessions.length > 1000) throw new Error("invalid peer session list");
          const sessions: PeerSession[] = [];
          for (const session of body.sessions) {
            if (!record(session) || typeof session.name !== "string" || session.name.length === 0 || session.name.length > 100
              || !record(session.identity) || typeof session.identity.wolfpackSessionId !== "string"
              || session.identity.wolfpackSessionId.length === 0 || session.identity.wolfpackSessionId.length > 128) continue;
            sessions.push({ name: session.name, identity: { wolfpackSessionId: session.identity.wolfpackSessionId },
              ...(isQuietAlertFact(session.quietAlert) ? { quietAlert: session.quietAlert } : {}) });
          }
          const current = await topology();
          if (controller.signal.aborted || current.origin !== own.origin || current.nodeId !== own.nodeId || current.peers.get(origin) !== nodeId) throw new Error("peer topology changed");
          const machine = classification.handshake.machine;
          return { machine: { identity: stableMachineIdentity(machine.tailnetNodeId, machine.installationId), name: machine.displayName }, sessions };
        });
        observations.push(observation);
      } catch (error: unknown) { log.warn("peer notification observation failed", { origin, error: errMsg(error) }); }
      finally { clearTimeout(timer); controller.abort(); }
    }
  }));
  return observations;
}
