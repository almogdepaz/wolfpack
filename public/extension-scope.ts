import type { SelectedExtensionScope } from "./extension-host.ts";

export interface SelectedTerminalIdentity {
  readonly sessionId: string | null | undefined;
  readonly machine: string | null | undefined;
}

/** Same-origin extension data may only follow the exact selected local terminal UUID. */
export function resolveSelectedExtensionScope(
  target: SelectedTerminalIdentity | null | undefined,
  localMachineIdentity: string,
): SelectedExtensionScope | null {
  if (!target?.sessionId) return null;
  if (target.machine && target.machine !== localMachineIdentity) {
    return { sessionId: null, unavailable: "Extension context is unavailable for a terminal served by another machine." };
  }
  return { sessionId: target.sessionId };
}
