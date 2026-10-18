import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { WorkerRelayGateway } from "./worker-client.ts";
import { getDefaultServerContext, getServerContextServiceCache } from "../server/context.ts";
import { getRelayPeerTransport } from "../server/relay-peer-transport.ts";

export interface GatewayOptions {
  readonly root?: string;
  readonly peerOrigin?: string;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
}

/** One memory-only protocol. Retired profiles are errors, not compatibility modes. */
export function getTaskRelayProfile(): "volatile-v1" {
  if (getServerContextServiceCache().taskRelayGateway) return "volatile-v1";
  const selected = process.env.WOLFPACK_TASK_RELAY_PROFILE;
  if (selected !== undefined && selected !== "volatile-v1") throw new TypeError("only memory-owned volatile-v1 is supported");
  return "volatile-v1";
}
export function createTaskRelayGateway(options: GatewayOptions): RelayGateway {
  getTaskRelayProfile();
  const worker: WorkerRelayGateway = new WorkerRelayGateway({ ...options,
    peerFetch: options.peerFetch ?? ((input, init) => getRelayPeerTransport(worker, options.peerOrigin).forward(input, init)) });
  return worker;
}
/** @deprecated Use the owning ServerContext.taskRelayGateway. */
export function getTaskRelayGateway(): RelayGateway { return getDefaultServerContext().taskRelayGateway; }
/** @deprecated Use the owning ServerContext.taskRelayGateway. */
export function getVolatileTaskRelayGateway(): RelayGateway { return getTaskRelayGateway(); }
export async function __setTaskRelayGatewayForTests(gateway: RelayGateway): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway setup is test-only");
  const cache = getServerContextServiceCache(getDefaultServerContext());
  if (cache.taskRelayGateway === gateway) return;
  await cache.taskRelayGateway?.close(); cache.taskRelayGateway = gateway;
}
export async function __resetTaskRelayGatewayForTests(): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway reset is test-only");
  const cache = getServerContextServiceCache();
  await cache.taskRelayGateway?.close(); cache.taskRelayGateway = undefined;
}
