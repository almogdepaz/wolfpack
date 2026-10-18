import { TaskGateway } from "../tasks/gateway.ts";
import { createTaskRelayGateway } from "../task-relay/gateway.ts";
import { ExtensionRouteService } from "./extension-routes.ts";
import type { RelayGateway } from "../task-relay/worker-protocol.ts";
import { loadConfig, remoteUrl, type Config } from "../config.js";
import { defaultEventBus, setDefaultEventBus, type EventBus } from "../event-bus.js";
import { BrokerSupervisor } from "./broker-supervisor.js";
import { supervisedBackend } from "./broker-session-backend.js";
import type { SessionBackend, PtyBackendMethods, SessionPromptBackendMethods } from "./backend-contract.js";

export type ServerBackend = SessionBackend & PtyBackendMethods & SessionPromptBackendMethods;

/**
 * Non-default contexts must use distinct taskRoot and taskRelayRoot values and
 * must not share an extension runtime (inject an independently owned extension
 * route service). Store lock maps are instance-local, while relay roots have a
 * single-owner guard. Close owned workers before reusing their roots.
 */
export interface ServerContext {
  readonly backend: ServerBackend;
  readonly events: EventBus;
  readonly config: Config | null;
  readonly supervisor?: BrokerSupervisor;
  readonly taskGateway: TaskGateway;
  readonly taskRelayGateway: RelayGateway;
  readonly extensionRouteService: ExtensionRouteService;
}

// Context-owned lazy instances. Compatibility test hooks reset only the default
// context cache, without constructing workers or rebinding a live inspector.
interface ServiceCache {
  taskGateway?: TaskGateway;
  taskRelayGateway?: RelayGateway;
  extensionRouteService?: ExtensionRouteService;
}
const serviceCaches = new WeakMap<ServerContext, ServiceCache>();
/** @internal Compatibility shim lookup; request handlers use context properties. */
export function getServerContextServiceCache(context: ServerContext): ServiceCache;
export function getServerContextServiceCache(): ServiceCache | undefined;
export function getServerContextServiceCache(context = current): ServiceCache | undefined {
  if (!context) return undefined;
  let cache = serviceCaches.get(context);
  if (!cache) { cache = {}; serviceCaches.set(context, cache); }
  return cache;
}

export interface ServerContextOptions extends Partial<ServerContext> {
  readonly taskRoot?: string;
  readonly taskRelayRoot?: string;
}

function defaultSupervisor(events: EventBus): BrokerSupervisor {
  return new BrokerSupervisor({ events, start: !process.env.WOLFPACK_TEST });
}

export function createServerContext(overrides: ServerContextOptions = {}): ServerContext {
  const events = overrides.events ?? defaultEventBus;
  const supervisor = overrides.supervisor ?? (overrides.backend ? undefined : defaultSupervisor(events));
  const backend = overrides.backend ?? supervisedBackend(supervisor!);
  const cache: ServiceCache = { taskGateway: overrides.taskGateway, taskRelayGateway: overrides.taskRelayGateway, extensionRouteService: overrides.extensionRouteService };
  const context: ServerContext = {
    get backend() { return overrides.backend ?? backend; },
    events,
    config: overrides.config === undefined ? loadConfig() : overrides.config,
    supervisor,
    get taskGateway() {
      return cache.taskGateway ??= new TaskGateway({ root: overrides.taskRoot ?? process.env.WOLFPACK_TASK_ROOT, inspectSession: selector => context.backend.inspectSession(selector) });
    },
    get taskRelayGateway() {
      return cache.taskRelayGateway ??= createTaskRelayGateway({ root: overrides.taskRelayRoot ?? process.env.WOLFPACK_TASK_RELAY_ROOT,
        peerOrigin: context.config ? remoteUrl(context.config) ?? undefined : undefined,
        inspectSession: selector => context.backend.inspectSession(selector) });
    },
    get extensionRouteService() {
      return cache.extensionRouteService ??= new ExtensionRouteService({ backend: { listSessionFacts: () => context.backend.listSessionFacts() } });
    },
  };
  serviceCaches.set(context, cache);
  return context;
}

let current: ServerContext | undefined;
export function getDefaultServerContext(): ServerContext {
  return current ??= createServerContext();
}
export function setDefaultServerContext(context: ServerContext): void {
  current = context;
  setDefaultEventBus(context.events);
}
export function resetDefaultServerContext(): void { current = undefined; }

/** Lazy compatibility view: old route exports follow test overrides without opening a broker on import. */
export const defaultServerContext: ServerContext = {
  get backend() { return getDefaultServerContext().backend; },
  get events() { return getDefaultServerContext().events; },
  get config() { return getDefaultServerContext().config; },
  get supervisor() { return getDefaultServerContext().supervisor; },
  get taskGateway() { return getDefaultServerContext().taskGateway; },
  get taskRelayGateway() { return getDefaultServerContext().taskRelayGateway; },
  get extensionRouteService() { return getDefaultServerContext().extensionRouteService; },
};
