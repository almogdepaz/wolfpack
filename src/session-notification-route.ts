const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 100;
const MAX_MACHINE_URL_LENGTH = 2048;
const LOCAL_MACHINE_ROUTE = "local";

export interface SessionNotificationReference {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly machineUrl: string;
}

function isBoundedNonEmpty(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

export function buildSessionNotificationUrl(reference: SessionNotificationReference): string {
  if (!isBoundedNonEmpty(reference.sessionId, MAX_SESSION_ID_LENGTH)) {
    throw new Error("session notification route requires a bounded stable session id");
  }
  if (!isBoundedNonEmpty(reference.sessionName, MAX_SESSION_NAME_LENGTH)) {
    throw new Error("session notification route requires a bounded session name");
  }
  if (reference.machineUrl.length > MAX_MACHINE_URL_LENGTH) {
    throw new Error("session notification machine context is too long");
  }

  const params = new URLSearchParams({
    sessionId: reference.sessionId,
    session: reference.sessionName,
    machine: reference.machineUrl || LOCAL_MACHINE_ROUTE,
  });
  return `/?${params.toString()}`;
}

export function parseSessionNotificationRoute(search: string): SessionNotificationReference | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("sessionId") ?? "";
  const sessionName = params.get("session") ?? "";
  const machine = params.get("machine") ?? "";
  if (!isBoundedNonEmpty(sessionId, MAX_SESSION_ID_LENGTH)) return null;
  if (!isBoundedNonEmpty(sessionName, MAX_SESSION_NAME_LENGTH)) return null;
  if (!isBoundedNonEmpty(machine, MAX_MACHINE_URL_LENGTH)) return null;

  return {
    sessionId,
    sessionName,
    machineUrl: machine === LOCAL_MACHINE_ROUTE ? "" : machine,
  };
}
