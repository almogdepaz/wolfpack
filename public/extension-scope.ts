import type { SelectedExtensionScope } from "./extension-host.ts";

export interface SelectedTerminalIdentity {
  readonly sessionId: string | null | undefined;
  readonly machine: string | null | undefined;
}

export interface WorkspaceExtensionScopeInput {
  readonly activeSurface: "single" | "manual-grid" | "delegation-grid";
  readonly selectedGridPane?: SelectedTerminalIdentity;
  readonly singleTerminal?: SelectedTerminalIdentity | null;
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

/** The active surface is authoritative: an identity-less grid pane cannot inherit a previous single-terminal scope. */
export function resolveWorkspaceExtensionScope(input: WorkspaceExtensionScopeInput, localMachineIdentity: string): SelectedExtensionScope | null {
  return input.activeSurface === "single"
    ? resolveSelectedExtensionScope(input.singleTerminal, localMachineIdentity)
    : resolveSelectedExtensionScope(input.selectedGridPane, localMachineIdentity);
}
