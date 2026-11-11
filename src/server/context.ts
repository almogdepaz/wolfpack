import { AgentRuntimeStateStore } from "./agent-status.js";
import { SessionIdentityStore } from "./session-identity.js";
import { SessionOrganizationService } from "./session-organization.ts";
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
  readonly sessionOrganization: SessionOrganizationService;
  readonly agentRuntimeStateStore: AgentRuntimeStateStore;
  readonly sessionIdentityStore: SessionIdentityStore;
  /** Drain an already-owned runtime store without constructing it. */
  flushRuntimeState(): Promise<void>;
  /** Drain owned stores and close workers without constructing unused services. */
  close(): Promise<void>;
}

// Context-owned lazy instances; closing a context does not replace its services.
interface ServiceCache {
  taskGateway?: TaskGateway;
  taskRelayGateway?: RelayGateway;
  extensionRouteService?: ExtensionRouteService;
  sessionOrganization?: SessionOrganizationService;
  agentRuntimeStateStore?: AgentRuntimeStateStore;
  sessionIdentityStore?: SessionIdentityStore;
}

export interface ServerContextOptions extends Partial<Omit<ServerContext, "close" | "flushRuntimeState">> {
  readonly taskRoot?: string;
  readonly taskRelayRoot?: string;
}

function defaultSupervisor(events: EventBus, sessionIdentityStore: () => SessionIdentityStore): BrokerSupervisor {
  return new BrokerSupervisor({ events, sessionIdentityStore, start: !process.env.WOLFPACK_TEST });
}

export function createServerContext(overrides: ServerContextOptions = {}): ServerContext {
  const events = overrides.events ?? defaultEventBus;
  const cache: ServiceCache = {
    taskGateway: overrides.taskGateway, taskRelayGateway: overrides.taskRelayGateway,
    extensionRouteService: overrides.extensionRouteService,
    agentRuntimeStateStore: overrides.agentRuntimeStateStore, sessionIdentityStore: overrides.sessionIdentityStore,
  };
  const sessionIdentityStore = () => cache.sessionIdentityStore ??= new SessionIdentityStore();
  const supervisor = overrides.supervisor ?? (overrides.backend ? undefined : defaultSupervisor(events, sessionIdentityStore));
  const backend = overrides.backend ?? supervisedBackend(supervisor!);
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
    get sessionOrganization() {
      return overrides.sessionOrganization ?? (cache.sessionOrganization ??= new SessionOrganizationService());
    },
    get agentRuntimeStateStore() { return cache.agentRuntimeStateStore ??= new AgentRuntimeStateStore(); },
    get sessionIdentityStore() { return sessionIdentityStore(); },
    async flushRuntimeState() { await cache.agentRuntimeStateStore?.flushForShutdown(); },
    async close() {
      await context.flushRuntimeState();
      await cache.taskRelayGateway?.close();
    },
    get extensionRouteService() {
      return cache.extensionRouteService ??= new ExtensionRouteService({ backend: { listSessionFacts: () => context.backend.listSessionFacts() } });
    },
  };
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
  get sessionOrganization() { return getDefaultServerContext().sessionOrganization; },
  get agentRuntimeStateStore() { return getDefaultServerContext().agentRuntimeStateStore; },
  get sessionIdentityStore() { return getDefaultServerContext().sessionIdentityStore; },
  async flushRuntimeState() { await current?.flushRuntimeState(); },
  async close() { await current?.close(); },
};
