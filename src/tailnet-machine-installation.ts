import { getMachineId } from "./tasks/machine-id.ts";

/** Reuses Wolfpack's durable install identity because it has this contract's install-wide authority. */
export function getInstallationId(): string {
  return getMachineId();
}
