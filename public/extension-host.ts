import { ExtensionContributionGate } from "../src/extensions/contribution-contract.ts";
import type { TerminalLayoutContribution } from "../src/extensions/layout-contract.ts";
import type { ExtensionRegistration, ExtensionViewContext } from "../src/extensions/sdk.ts";
import type { ExtensionCatalogEnvelope, ExtensionCatalogInstallation, ExtensionDocumentReadEnvelope } from "../src/extensions/runtime-contract.ts";
import { browserAuthFetch } from "./browser-auth.ts";
import { ContextViewRegistry, type ContextViewScope } from "./context-view-registry.ts";
import { SharedDocumentPoller } from "./extension-document-polling.ts";
import { loadAuthenticatedExtensionBundle } from "./extension-loader.ts";

export interface SelectedExtensionScope { readonly sessionId: string | null; readonly unavailable?: string; }
export interface ExtensionHostOptions {
  readonly container: HTMLElement;
  readonly scope: () => SelectedExtensionScope | null;
  readonly safeMode?: () => boolean;
  readonly registerLayout?: (contribution: TerminalLayoutContribution) => (() => void);
  readonly onChange?: () => void;
}

interface LoadedPackage { readonly digest: string; readonly cleanup: () => void; }
interface ViewOwner { readonly extension: ExtensionCatalogInstallation; readonly unregister: () => void; }

function keyFor(installationId: string, extensionId: string, scopeId: string, suffix: string): string {
  return `wolfpack-extension-ui:v1:${installationId}:${extensionId}:${scopeId}:${suffix}`;
}


/** Browser host boundary: catalog/auth/loader/view cleanup are host-owned; package code receives only SDK context. */
export class ExtensionHost {
  private readonly registry: ContextViewRegistry;
  private readonly loaded = new Map<string, LoadedPackage>();
  private readonly owners = new Map<string, ViewOwner>();
  private readonly pollers = new Map<string, SharedDocumentPoller>();
  private readonly visibleViews = new Set<string>();
  private generation = 0;
  private currentScope: SelectedExtensionScope | null = null;
  private currentInstallationId: string | null = null;
  private catalog: ExtensionCatalogEnvelope | null = null;
  private disposed = false;

  constructor(private readonly options: ExtensionHostOptions) {
    this.registry = new ContextViewRegistry({
      container: options.container,
      createContext: (scope, signal, viewId) => this.contextFor(scope, signal, viewId),
      onVisibilityChange: (viewId, visible) => this.setViewVisible(viewId, visible),
      onChange: () => this.render(),
    });
    document.addEventListener("visibilitychange", this.onDocumentVisibility);
  }

  get diagnostic(): string { return this.registry.diagnostic; }
  get selectedId(): string | null { return this.registry.selectedId; }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const scope = this.options.scope();
    this.currentScope = scope;
    if (!scope || !scope.sessionId || scope.unavailable) {
      this.registry.setScope(null);
      this.cleanupAll();
      this.render(scope?.unavailable ?? "Select a live terminal with an exact session identity to view extension context.");
      return;
    }
    if (this.options.safeMode?.()) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
    try {
      const response = await browserAuthFetch("/api/extensions", { cache: "no-store" });
      if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
      const catalog = await response.json() as ExtensionCatalogEnvelope;
      if (this.disposed || generation !== this.generation) return;
      if (catalog.safeMode) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
      this.catalog = catalog;
      const installationId = catalog.installations[0]?.installationId ?? null;
      this.currentInstallationId = installationId;
      this.registry.setScope(installationId ? { installationId, sessionId: scope.sessionId } : null);
      const active = new Set(catalog.installations.filter(item => item.enabled && item.ui).map(item => item.extensionId));
      for (const id of [...this.loaded.keys()]) if (!active.has(id)) this.cleanupPackage(id);
      for (const item of catalog.installations) if (item.enabled && item.ui) await this.load(item, generation);
      if (generation === this.generation) this.render();
    } catch {
      if (generation === this.generation) { this.registry.setScope(null); this.cleanupAll(); this.render("Extension catalog unavailable for the selected scope."); }
    }
  }

  select(id: string): void { this.registry.select(id); }
  dispose(): void { if (this.disposed) return; this.disposed = true; ++this.generation; document.removeEventListener("visibilitychange", this.onDocumentVisibility); this.cleanupAll(); this.registry.dispose(); }

  private async load(item: ExtensionCatalogInstallation, generation: number): Promise<void> {
    const existing = this.loaded.get(item.extensionId);
    if (existing?.digest === item.package.digest) return;
    if (existing) this.cleanupPackage(item.extensionId);
    try {
      const module = await loadAuthenticatedExtensionBundle<{ default?: ExtensionRegistration }>(item.ui!.url, item.ui!.digest, { safeMode: false });
      if (this.disposed || generation !== this.generation) return;
      if (typeof module.default !== "function") throw new Error("extension bundle has no registration function");
      const gate = new ExtensionContributionGate(item.extensionId);
      const cleanups: Array<() => void> = [];
      const registrationCleanup = module.default({
        registerContextView: contribution => {
          const viewId = gate.register("context-view", contribution.id).qualifiedId;
          const unregister = this.registry.register(viewId, contribution);
          this.owners.set(viewId, { extension: item, unregister });
          cleanups.push(() => { this.owners.delete(viewId); unregister(); });
        },
        registerTerminalLayout: contribution => {
          const qualifiedId = gate.register("terminal-layout", contribution.id).qualifiedId;
          // Layout integration is injected by app.ts; errors are contained with this package.
          const unregister = this.options.registerLayout?.({ ...contribution, id: qualifiedId }) ?? (() => {});
          cleanups.push(unregister);
        },
      });
      if (typeof registrationCleanup === "function") cleanups.push(registrationCleanup);
      this.loaded.set(item.extensionId, { digest: item.package.digest, cleanup: () => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} } } });
    } catch {
      this.render(`Extension ${item.extensionId} could not be registered.`);
    }
  }

  private contextFor(scope: ContextViewScope, signal: AbortSignal, viewId: string): ExtensionViewContext {
    const owner = this.owners.get(viewId)?.extension;
    const extensionId = owner?.extensionId ?? "";
    const storage = {
      get: (key: string) => localStorage.getItem(keyFor(scope.installationId, extensionId, scope.sessionId, `storage:${key}`)),
      set: (key: string, value: string) => localStorage.setItem(keyFor(scope.installationId, extensionId, scope.sessionId, `storage:${key}`), value),
      remove: (key: string) => localStorage.removeItem(keyFor(scope.installationId, extensionId, scope.sessionId, `storage:${key}`)),
    };
    const read = async (documentId: string): Promise<unknown> => this.readDocument(extensionId, documentId, scope, signal).then(value => value.document);
    const subscribe = (documentId: string, listener: (value: unknown, revision: number) => void): (() => void) => {
      const poller = this.poller(extensionId, documentId, scope);
      const unsubscribe = poller.subscribe(listener);
      signal.addEventListener("abort", unsubscribe, { once: true });
      return unsubscribe;
    };
    return Object.freeze({ signal, scope: Object.freeze({ ...scope }), selection: Object.freeze({ selectedSessionId: scope.sessionId }), theme: Object.freeze({}), storage: Object.freeze(storage), documents: Object.freeze({ read, subscribe }) });
  }

  private poller(extensionId: string, documentId: string, scope: ContextViewScope): SharedDocumentPoller {
    const key = keyFor(scope.installationId, extensionId, scope.sessionId, `document:${documentId}`);
    let poller = this.pollers.get(key);
    if (!poller) {
      poller = new SharedDocumentPoller({ read: signal => this.readDocument(extensionId, documentId, scope, signal) });
      this.pollers.set(key, poller);
    }
    poller.setPaused(document.visibilityState !== "visible" || !this.visibleViews.size);
    return poller;
  }

  private async readDocument(extensionId: string, documentId: string, scope: ContextViewScope, signal: AbortSignal): Promise<{ document: unknown | null; revision: number }> {
    const selected = this.currentScope;
    if (!selected || selected.sessionId !== scope.sessionId || this.currentInstallationId !== scope.installationId) throw new Error("stale extension scope");
    const url = `/api/extensions/documents/${encodeURIComponent(extensionId)}/${encodeURIComponent(documentId)}?session=${encodeURIComponent(scope.sessionId)}`;
    const response = await browserAuthFetch(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error("extension document unavailable");
    const value = await response.json() as ExtensionDocumentReadEnvelope;
    if (value.installationId !== scope.installationId || value.scopeSessionId !== scope.sessionId || value.extensionId !== extensionId || value.documentId !== documentId) throw new Error("extension document identity mismatch");
    return { document: value.document, revision: value.revision };
  }

  private setViewVisible(viewId: string, visible: boolean): void { if (visible) this.visibleViews.add(viewId); else this.visibleViews.delete(viewId); this.pausePollers(); }
  private onDocumentVisibility = (): void => this.pausePollers();
  private pausePollers(): void { const paused = document.visibilityState !== "visible" || !this.visibleViews.size; for (const poller of this.pollers.values()) poller.setPaused(paused); }
  private cleanupPackage(extensionId: string): void { const loaded = this.loaded.get(extensionId); if (!loaded) return; this.loaded.delete(extensionId); loaded.cleanup(); }
  private cleanupAll(): void { for (const id of [...this.loaded.keys()]) this.cleanupPackage(id); for (const poller of this.pollers.values()) poller.dispose(); this.pollers.clear(); this.visibleViews.clear(); }
  private render(message = this.registry.diagnostic): void {
    const tabs = this.options.container.querySelector<HTMLElement>("[data-extension-tabs]") ?? document.createElement("div");
    if (!tabs.parentElement) { tabs.dataset.extensionTabs = ""; tabs.setAttribute("role", "tablist"); this.options.container.prepend(tabs); }
    tabs.replaceChildren();
    for (const entry of this.registry.entries()) { const button = document.createElement("button"); button.type = "button"; button.textContent = entry.contribution.title; button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(entry.id === this.registry.selectedId)); button.addEventListener("click", () => this.select(entry.id)); tabs.append(button); }
    let status = this.options.container.querySelector<HTMLElement>("[data-extension-status]");
    if (!status) { status = document.createElement("p"); status.dataset.extensionStatus = ""; status.setAttribute("role", "status"); this.options.container.prepend(status); }
    status.textContent = message || (this.registry.entries().length ? "Select a context view." : "No enabled context views for this scope.");
    this.options.onChange?.();
  }
}
