import { loadConfig, type Config } from "../config.js";
import { defaultEventBus, setDefaultEventBus, type EventBus } from "../event-bus.js";
import { BrokerSupervisor } from "./broker-supervisor.js";
import { supervisedBackend } from "./broker-session-backend.js";
import type { SessionBackend, PtyBackendMethods, SessionPromptBackendMethods } from "./backend-contract.js";

export type ServerBackend = SessionBackend & PtyBackendMethods & SessionPromptBackendMethods;

export interface ServerContext {
  readonly backend: ServerBackend;
  readonly events: EventBus;
  readonly config: Config | null;
  readonly supervisor?: BrokerSupervisor;
}

function defaultSupervisor(events: EventBus): BrokerSupervisor {
  return new BrokerSupervisor({ events, start: !process.env.WOLFPACK_TEST });
}

export function createServerContext(overrides: Partial<ServerContext> = {}): ServerContext {
  const events = overrides.events ?? defaultEventBus;
  const supervisor = overrides.supervisor ?? (overrides.backend ? undefined : defaultSupervisor(events));
  return {
    backend: overrides.backend ?? supervisedBackend(supervisor!),
    events,
    config: overrides.config === undefined ? loadConfig() : overrides.config,
    supervisor,
  };
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
};
