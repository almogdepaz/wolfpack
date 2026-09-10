import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { WorkerRelayGateway } from "./worker-client.ts";
import { loadConfig, remoteUrl } from "../cli/config.ts";
import { getRelayPeerTransport } from "../server/relay-peer-transport.ts";

export interface GatewayOptions {
  readonly root?: string;
  readonly peerOrigin?: string;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
}
let singleton: RelayGateway | undefined;

/** One memory-only protocol. Retired profiles are errors, not compatibility modes. */
export function getTaskRelayProfile(): "volatile-v1" {
  if (singleton) return "volatile-v1";
  const selected = process.env.WOLFPACK_TASK_RELAY_PROFILE;
  if (selected !== undefined && selected !== "volatile-v1") throw new TypeError("only memory-owned volatile-v1 is supported");
  return "volatile-v1";
}
export function getTaskRelayGateway(): RelayGateway {
  getTaskRelayProfile();
  if (!singleton) {
    const config = loadConfig(), origin = config ? remoteUrl(config) ?? undefined : undefined;
    const worker: WorkerRelayGateway = new WorkerRelayGateway({ root: process.env.WOLFPACK_TASK_RELAY_ROOT, peerOrigin: origin,
      peerFetch: (input, init) => getRelayPeerTransport(worker, origin).forward(input, init) });
    singleton = worker;
  }
  return singleton;
}
export function getVolatileTaskRelayGateway(): RelayGateway { return getTaskRelayGateway(); }
export async function __setTaskRelayGatewayForTests(gateway: RelayGateway): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway setup is test-only");
  if (singleton === gateway) return;
  await singleton?.close(); singleton = gateway;
}
export async function __resetTaskRelayGatewayForTests(): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway reset is test-only");
  await singleton?.close(); singleton = undefined;
}
