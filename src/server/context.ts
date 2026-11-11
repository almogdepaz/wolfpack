import { createPushService } from "./push.js";
import { createTerminalSessions, type TerminalSessionOptions } from "./websocket.js";
import type { ClaudeManagedSettingsDropIn } from "../claude-integration.js";
import { getCachedJwtAuthConfig, type JwtAuthConfig } from "../auth.js";
import { createChildEvents } from "./child-events.js";
import { createSessionDeath } from "./session-death.js";
import { createViewerInput } from "./viewer-input.js";
import { createWebSocketTickets } from "./ws-ticket.js";
import { createSessionCascade } from "./session-cascade.js";
import { createSessionObservation } from "./session-observation.js";
import { createChildEventDeliveryOwner } from "./child-event-delivery.js";
import { AgentRuntimeStateStore } from "./agent-status.js";
import { SessionIdentityStore } from "./session-identity.js";
import { SessionOrganizationService } from "./session-organization.ts";
import { TaskStore } from "../tasks/store.ts";
import { TaskGateway } from "../tasks/gateway.ts";
import { createTaskRelayGateway } from "../task-relay/gateway.ts";
import { ExtensionRouteService } from "./extension-routes.ts";
import type { RelayGateway } from "../task-relay/worker-protocol.ts";
import { loadConfig, remoteUrl, type Config } from "../config.js";
import { defaultEventBus, setDefaultEventBus, type EventBus } from "../event-bus.js";
import { BrokerSupervisor } from "./broker-supervisor.js";
import { supervisedBackend } from "./broker-session-backend.js";
import type { SessionBackend, PtyBackendMethods, SessionPromptBackendMethods } from "./backend-contract.js";

export type ServerBackend = SessionBackend & PtyBackendMethods & SessionPromptBackendMethods & Partial<{
  readonly childEvents: ReturnType<typeof createChildEvents>;
  readonly sessionDeath: ReturnType<typeof createSessionDeath>;
  readonly viewerInput: ReturnType<typeof createViewerInput>;
}>;

/**
 * Non-default contexts must use distinct taskRoot and taskRelayRoot values and
 * must not share an extension runtime (inject an independently owned extension
 * route service). Store lock maps are instance-local, while relay roots have a
 * single-owner guard. Close owned workers before reusing their roots.
 */
export interface ServerContext {
  readonly push: ReturnType<typeof createPushService>;
  readonly terminals: ReturnType<typeof createTerminalSessions>;
  readonly jwtAuthConfig: JwtAuthConfig;
  readonly devDir?: string;
  readonly claudeManagedSettingsDropIn?: ClaudeManagedSettingsDropIn;
  readonly childEvents: ReturnType<typeof createChildEvents>;
  readonly sessionDeath: ReturnType<typeof createSessionDeath>;
  readonly viewerInput: ReturnType<typeof createViewerInput>;
  readonly webSocketTickets: ReturnType<typeof createWebSocketTickets>;
  readonly sessionCascade: ReturnType<typeof createSessionCascade>;
  readonly sessionObservation: ReturnType<typeof createSessionObservation>;
  readonly childEventDelivery: ReturnType<typeof createChildEventDeliveryOwner>;
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
  push?: ReturnType<typeof createPushService>;
  terminals?: ReturnType<typeof createTerminalSessions>;
  childEvents?: ReturnType<typeof createChildEvents>;
  sessionDeath?: ReturnType<typeof createSessionDeath>;
  viewerInput?: ReturnType<typeof createViewerInput>;
  webSocketTickets?: ReturnType<typeof createWebSocketTickets>;
  sessionCascade?: ReturnType<typeof createSessionCascade>;
  sessionObservation?: ReturnType<typeof createSessionObservation>;
  childEventDelivery?: ReturnType<typeof createChildEventDeliveryOwner>;
  taskGateway?: TaskGateway;
  taskRelayGateway?: RelayGateway;
  extensionRouteService?: ExtensionRouteService;
  sessionOrganization?: SessionOrganizationService;
  agentRuntimeStateStore?: AgentRuntimeStateStore;
  sessionIdentityStore?: SessionIdentityStore;
}

export interface ServerContextOptions extends Partial<Omit<ServerContext, "close" | "flushRuntimeState">> {
  readonly observationCacheTtlMs?: number;
  readonly terminalPrefillDelayMs?: number;
  readonly onTerminalAttachAttempt?: TerminalSessionOptions["onAttachAttempt"];
  readonly taskRoot?: string;
  readonly taskRelayRoot?: string;
}

export function createServerContext(overrides: ServerContextOptions = {}): ServerContext {
  const events = overrides.events ?? defaultEventBus;
  const cache: ServiceCache = {
    push: overrides.push,
    terminals: overrides.terminals,
    childEvents: overrides.childEvents,
    sessionDeath: overrides.sessionDeath,
    viewerInput: overrides.viewerInput,
    webSocketTickets: overrides.webSocketTickets,
    sessionCascade: overrides.sessionCascade,
    sessionObservation: overrides.sessionObservation,
    childEventDelivery: overrides.childEventDelivery,
    taskGateway: overrides.taskGateway, taskRelayGateway: overrides.taskRelayGateway,
    extensionRouteService: overrides.extensionRouteService,
    agentRuntimeStateStore: overrides.agentRuntimeStateStore, sessionIdentityStore: overrides.sessionIdentityStore,
  };
  const sessionIdentityStore = () => cache.sessionIdentityStore ??= new SessionIdentityStore(overrides.devDir);
  const childEvents = cache.childEvents ??= overrides.backend?.childEvents ?? overrides.supervisor?.childEvents ?? createChildEvents();
  const sessionDeath = cache.sessionDeath ??= overrides.backend?.sessionDeath ?? overrides.supervisor?.sessionDeath ?? createSessionDeath();
  const viewerInput = cache.viewerInput ??= overrides.backend?.viewerInput ?? overrides.supervisor?.viewerInput ?? createViewerInput();
  const supervisor = overrides.supervisor ?? (overrides.backend ? undefined : new BrokerSupervisor({
    events, sessionIdentityStore, childEvents, sessionDeath, viewerInput,
    claudeManagedSettingsDropIn: overrides.claudeManagedSettingsDropIn, start: !process.env.WOLFPACK_TEST,
  }));
  const backend = overrides.backend ?? supervisedBackend(supervisor!);
  const context: ServerContext = {
    get push() { return cache.push ??= createPushService(); },
    get terminals() { return cache.terminals ??= createTerminalSessions(context, { prefillDelayMs: overrides.terminalPrefillDelayMs, onAttachAttempt: overrides.onTerminalAttachAttempt }); },
    devDir: overrides.devDir,
    claudeManagedSettingsDropIn: overrides.claudeManagedSettingsDropIn,
    get jwtAuthConfig() { return overrides.jwtAuthConfig ?? getCachedJwtAuthConfig(); },
    childEvents, sessionDeath, viewerInput,
    get webSocketTickets() { return cache.webSocketTickets ??= createWebSocketTickets(); },
    get sessionCascade() { return cache.sessionCascade ??= createSessionCascade(context); },
    get sessionObservation() { return cache.sessionObservation ??= createSessionObservation(context, overrides.observationCacheTtlMs); },
    get childEventDelivery() { return cache.childEventDelivery ??= createChildEventDeliveryOwner(childEvents.onChildEvent); },
    get backend() { return overrides.backend ?? backend; },
    events,
    config: overrides.config === undefined ? loadConfig() : overrides.config,
    supervisor,
    get taskGateway() {
      if (!cache.taskGateway) {
        const root = overrides.taskRoot ?? process.env.WOLFPACK_TASK_ROOT;
        cache.taskGateway = new TaskGateway({
          root, store: new TaskStore({ root, publishEvent: body => context.events.publishEvent(body) }),
          inspectSession: selector => context.backend.inspectSession(selector),
        });
      }
      return cache.taskGateway;
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
      cache.terminals?.dispose();
      cache.sessionCascade?.dispose();
      cache.childEventDelivery?.dispose();
      await cache.sessionObservation?.dispose();
      cache.push?.dispose();
      await context.flushRuntimeState();
      await cache.taskRelayGateway?.close();
      supervisor?.close();
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
  get push() { return getDefaultServerContext().push; },
  get terminals() { return getDefaultServerContext().terminals; },
  get devDir() { return getDefaultServerContext().devDir; },
  get claudeManagedSettingsDropIn() { return getDefaultServerContext().claudeManagedSettingsDropIn; },
  get jwtAuthConfig() { return getDefaultServerContext().jwtAuthConfig; },
  get childEvents() { return getDefaultServerContext().childEvents; },
  get sessionDeath() { return getDefaultServerContext().sessionDeath; },
  get viewerInput() { return getDefaultServerContext().viewerInput; },
  get webSocketTickets() { return getDefaultServerContext().webSocketTickets; },
  get sessionCascade() { return getDefaultServerContext().sessionCascade; },
  get sessionObservation() { return getDefaultServerContext().sessionObservation; },
  get childEventDelivery() { return getDefaultServerContext().childEventDelivery; },
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
