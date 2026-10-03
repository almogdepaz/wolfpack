import type { ExtensionCatalogInstallation } from "../src/extensions/runtime-contract.ts";

type Identity = Pick<ExtensionCatalogInstallation, "installationId" | "extensionId">;
export const WIDGET_VISIBILITY_PREFIX = "wolfpack-widget-visibility:v1:";

/** Browser/installation-local UI preference, not a package enablement or trust boundary. */
export class WidgetVisibility {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}
  private key(item: Identity): string { return `${WIDGET_VISIBILITY_PREFIX}${item.installationId}:${item.extensionId}`; }
  isVisible(item: Identity): boolean {
    try { return this.storage.getItem(this.key(item)) !== "hidden"; }
    catch { return true; }
  }
  setVisible(item: Identity, visible: boolean): void {
    // Persist before notifying; storage failure must not masquerade as a saved change.
    this.storage.setItem(this.key(item), visible ? "shown" : "hidden");
    this.changed();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed(): void { for (const listener of this.listeners) listener(); }
}
