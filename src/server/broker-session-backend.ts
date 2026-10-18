import { DuplicateSessionError } from "./backend-contract.js";
import type { SessionBackend } from "./backend-contract.js";
import type { ServerBackend } from "./context.js";
import type { BrokerSupervisor } from "./broker-supervisor.js";
import { createLogger } from "../log.js";

const log = createLogger("backend");
const unavailable = (): never => { throw new Error("broker backend unavailable"); };
const rejectUnavailable = async (): Promise<never> => unavailable();

/** Preserve the former router's empty reads/no-op cleanup and rejected async operations. */
const unavailableBackend: ServerBackend = {
  list: async () => [],
  listSessionFacts: async () => [],
  listIdentities: async () => ({}),
  inspectSession: rejectUnavailable,
  createSession: rejectUnavailable,
  killSession: rejectUnavailable,
  killSessionById: rejectUnavailable,
  hasSession: rejectUnavailable,
  capturePane: rejectUnavailable,
  captureSessionSnapshotById: rejectUnavailable,
  resize: rejectUnavailable,
  send: rejectUnavailable,
  sendKey: rejectUnavailable,
  sessionDir: () => undefined,
  cleanupOrphans: async () => {},
  onSessionData: unavailable,
  writeToTerminal: unavailable,
  getSessionPrefill: rejectUnavailable,
  beginSessionAttach: rejectUnavailable,
  isSessionAlive: unavailable,
  onSessionLifecycle: unavailable,
  promptAndWaitForOutput: rejectUnavailable,
  sendAndObserveSubmission: rejectUnavailable,
};

/**
 * Retained session backends follow watchdog recovery, as the old router did.
 * Streaming attaches instead pin supervisor.backend() for their whole lifetime.
 * Only the former router's non-forwarding policy lives here.
 */
export function supervisedBackend(supervisor: BrokerSupervisor): ServerBackend {
  const current = () => supervisor.backend() ?? unavailableBackend;
  const policy: Pick<SessionBackend, "list" | "listSessionFacts" | "createSession"> = {
    list: async () => [...await current().list()].sort(),
    listSessionFacts: async () => [...await current().listSessionFacts()].sort((a, b) => a.name.localeCompare(b.name)),
    createSession: async (...args) => {
      const backend = current();
      const [name] = args;
      if ((await backend.list()).includes(name)) throw new DuplicateSessionError(name);
      const identity = await backend.createSession(...args);
      log.info("session created via router", { name, backend: "broker" });
      return identity;
    },
  };
  return new Proxy(unavailableBackend, {
    get(_target, property) {
      const owner = Object.hasOwn(policy, property) ? policy : current();
      const value = Reflect.get(owner, property);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
}
