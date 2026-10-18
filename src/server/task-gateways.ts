import { TaskGateway } from "../tasks/gateway.ts";
import type { RelayGateway } from "../task-relay/worker-protocol.ts";
import { getDefaultServerContext, getServerContextServiceCache } from "./context.ts";

/** @deprecated Use the owning ServerContext.taskGateway. */
export function getTaskGateway(): TaskGateway { return getDefaultServerContext().taskGateway; }
/** @deprecated Use the owning ServerContext.taskRelayGateway. */
export function getTaskRelayGateway(): RelayGateway { return getDefaultServerContext().taskRelayGateway; }
/** @deprecated Use the owning ServerContext.taskRelayGateway. */
export function getVolatileTaskRelayGateway(): RelayGateway { return getTaskRelayGateway(); }

export function __resetTaskGatewayForTests(options?: ConstructorParameters<typeof TaskGateway>[0]): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("task gateway reset is test-only");
  if (options !== undefined) {
    const context = getDefaultServerContext();
    getServerContextServiceCache(context).taskGateway = new TaskGateway({ ...options,
      inspectSession: options.inspectSession ?? (selector => context.backend.inspectSession(selector)) });
    return;
  }
  const cache = getServerContextServiceCache();
  if (cache) cache.taskGateway = undefined;
}

export async function __setTaskRelayGatewayForTests(gateway: RelayGateway): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway setup is test-only");
  const cache = getServerContextServiceCache(getDefaultServerContext());
  if (cache.taskRelayGateway === gateway) return;
  await cache.taskRelayGateway?.close(); cache.taskRelayGateway = gateway;
}

export async function __resetTaskRelayGatewayForTests(): Promise<void> {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway reset is test-only");
  const cache = getServerContextServiceCache();
  if (!cache) return;
  await cache.taskRelayGateway?.close(); cache.taskRelayGateway = undefined;
}
