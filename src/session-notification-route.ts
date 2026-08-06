import {
  LOCAL_MACHINE_IDENTITY,
  isStableMachineIdentity,
} from "./tailnet-peer-registry.ts";

const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 100;

export interface SessionNotificationReference {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly machineIdentity: string;
}

function isBoundedNonEmpty(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

function isNotificationMachineIdentity(value: string): boolean {
  return value === LOCAL_MACHINE_IDENTITY || isStableMachineIdentity(value);
}

/** Push/deep-link routes carry only stable identities; origins are resolved by the verified browser registry. */
export function buildSessionNotificationUrl(reference: SessionNotificationReference): string {
  if (!isBoundedNonEmpty(reference.sessionId, MAX_SESSION_ID_LENGTH)) {
    throw new Error("session notification route requires a bounded stable session id");
  }
  if (!isBoundedNonEmpty(reference.sessionName, MAX_SESSION_NAME_LENGTH)) {
    throw new Error("session notification route requires a bounded session name");
  }
  if (!isNotificationMachineIdentity(reference.machineIdentity)) {
    throw new Error("session notification route requires a stable machine identity");
  }

  const params = new URLSearchParams({
    sessionId: reference.sessionId,
    session: reference.sessionName,
    machine: reference.machineIdentity,
  });
  return `/?${params.toString()}`;
}

export function parseSessionNotificationRoute(search: string): SessionNotificationReference | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("sessionId") ?? "";
  const sessionName = params.get("session") ?? "";
  const machineIdentity = params.get("machine") ?? "";
  if (!isBoundedNonEmpty(sessionId, MAX_SESSION_ID_LENGTH)) return null;
  if (!isBoundedNonEmpty(sessionName, MAX_SESSION_NAME_LENGTH)) return null;
  if (!isNotificationMachineIdentity(machineIdentity)) return null;

  return { sessionId, sessionName, machineIdentity };
}
