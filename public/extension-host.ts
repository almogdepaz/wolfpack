import { ExtensionContributionGate } from "../src/extensions/contribution-contract.ts";
import { isExtensionIdentifier } from "../src/extensions/contribution-metadata.ts";
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
  readonly authFetch?: typeof browserAuthFetch;
  readonly bundleLoader?: typeof loadAuthenticatedExtensionBundle;
  readonly onChange?: () => void;
}

interface LoadedPackage { readonly fingerprint: string; readonly cleanup: () => void; }
interface ViewOwner { readonly extension: ExtensionCatalogInstallation; readonly unregister: () => void; }

type JsonRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function keyFor(installationId: string, extensionId: string, scopeId: string, suffix: string): string {
  return `wolfpack-extension-ui:v1:${installationId}:${extensionId}:${scopeId}:${suffix}`;
}
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string"; }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function nonNegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function catalogFailure(): never { throw new Error("invalid extension catalog envelope"); }

/** Treat server JSON as hostile until every identity used for storage or loading is checked. */
function parseCatalog(value: unknown): ExtensionCatalogEnvelope {
  if (!record(value) || typeof value.safeMode !== "boolean" || !Array.isArray(value.installations)) return catalogFailure();
  let installationId: string | undefined;
  const extensionIds = new Set<string>();
  const installations: ExtensionCatalogInstallation[] = value.installations.map((candidate) => {
    if (!record(candidate) || !text(candidate.installationId) || !UUID.test(candidate.installationId) || !text(candidate.extensionId) || !isExtensionIdentifier(candidate.extensionId) || typeof candidate.enabled !== "boolean" || !record(candidate.package) || !text(candidate.package.name) || !text(candidate.package.version) || !text(candidate.package.digest) || !SHA256.test(candidate.package.digest) || !Array.isArray(candidate.documents)) return catalogFailure();
    if (installationId !== undefined && installationId !== candidate.installationId) return catalogFailure();
    installationId = candidate.installationId;
    if (extensionIds.has(candidate.extensionId)) return catalogFailure();
    extensionIds.add(candidate.extensionId);
    const documents = candidate.documents.map((document) => {
      if (!record(document) || !text(document.id) || !isExtensionIdentifier(document.id) || !positiveSafeInteger(document.schemaVersion)) return catalogFailure();
      return Object.freeze({ id: document.id, schemaVersion: document.schemaVersion });
    });
    if (documents.length > 32) return catalogFailure();
    let ui: ExtensionCatalogInstallation["ui"];
    if (candidate.ui !== undefined) {
      if (!record(candidate.ui) || !text(candidate.ui.path) || !text(candidate.ui.url) || !text(candidate.ui.digest) || !SHA256.test(candidate.ui.digest) || candidate.ui.mime !== "text/javascript") return catalogFailure();
      ui = Object.freeze({ path: candidate.ui.path, url: candidate.ui.url, digest: candidate.ui.digest, mime: "text/javascript" });
    }
    return Object.freeze({ installationId: candidate.installationId, extensionId: candidate.extensionId, package: Object.freeze({ name: candidate.package.name, version: candidate.package.version, digest: candidate.package.digest }), enabled: candidate.enabled, ...(ui ? { ui } : {}), documents: Object.freeze(documents) });
  });
  return Object.freeze({ safeMode: value.safeMode, installations: Object.freeze(installations) });
}
function packageFingerprint(item: ExtensionCatalogInstallation): string {
  return `${item.installationId}:${item.extensionId}:${item.package.digest}:${item.ui?.url ?? ""}:${item.ui?.digest ?? ""}`;
}
function parseDocumentEnvelope(value: unknown): ExtensionDocumentReadEnvelope {
  if (!record(value) || !text(value.installationId) || !UUID.test(value.installationId) || !text(value.scopeSessionId) || !UUID.test(value.scopeSessionId) || !text(value.extensionId) || !isExtensionIdentifier(value.extensionId) || !text(value.documentId) || !isExtensionIdentifier(value.documentId) || !nonNegativeSafeInteger(value.revision) || !("document" in value)) return catalogFailure();
  return Object.freeze({ installationId: value.installationId, scopeSessionId: value.scopeSessionId, extensionId: value.extensionId, documentId: value.documentId, revision: value.revision, document: value.document });
}


/** Browser host boundary: catalog/auth/loader/view cleanup are host-owned; package code receives only SDK context. */
export class ExtensionHost {
  private readonly registry: ContextViewRegistry;
  private readonly loaded = new Map<string, LoadedPackage>();
  private readonly owners = new Map<string, ViewOwner>();
  private readonly pollers = new Map<string, SharedDocumentPoller>();
  /** Subscriber counts by exact document key/view: hidden views must not keep another key polling. */
  private readonly pollerViewCounts = new Map<string, Map<string, number>>();
  private readonly viewPollerKeys = new Map<string, Set<string>>();
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
    const previousScope = this.currentScope;
    this.currentScope = scope;
    if (!scope || !scope.sessionId || scope.unavailable) {
      this.registry.setScope(null);
      this.cleanupAll();
      this.render(scope?.unavailable ?? "Select a live terminal with an exact session identity to view extension context.");
      return;
    }
    if (this.options.safeMode?.()) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
    try {
      const response = await (this.options.authFetch ?? browserAuthFetch)("/api/extensions", { cache: "no-store" });
      if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
      const catalog = parseCatalog(await response.json());
      if (this.disposed || generation !== this.generation) return;
      if (catalog.safeMode) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
      this.catalog = catalog;
      const installationId = catalog.installations[0]?.installationId ?? null;
      // A scope is a resource boundary, not just a fetch argument. Abort and
      // dispose old view/poll resources before exposing any replacement scope.
      if (previousScope?.sessionId !== scope.sessionId || this.currentInstallationId !== installationId) {
        this.registry.setScope(null);
        this.cleanupAll();
      }
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
    const fingerprint = packageFingerprint(item);
    if (existing?.fingerprint === fingerprint) return;
    if (existing) this.cleanupPackage(item.extensionId);
    const cleanups: Array<() => void> = [];
    try {
      const module = await (this.options.bundleLoader ?? loadAuthenticatedExtensionBundle)<{ default?: ExtensionRegistration }>(item.ui!.url, item.ui!.digest, { safeMode: false });
      if (this.disposed || generation !== this.generation) return;
      if (typeof module.default !== "function") throw new Error("extension bundle has no registration function");
      const gate = new ExtensionContributionGate(item.extensionId);
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
      this.loaded.set(item.extensionId, { fingerprint, cleanup: () => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} } } });
    } catch {
      for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} }
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
      const pollerKey = keyFor(scope.installationId, extensionId, scope.sessionId, `document:${documentId}`);
      const poller = this.poller(extensionId, documentId, scope, viewId, pollerKey);
      const unsubscribe = poller.subscribe(listener);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
        this.unlinkPollerView(pollerKey, viewId);
      };
      signal.addEventListener("abort", release, { once: true });
      return release;
    };
    return Object.freeze({ signal, scope: Object.freeze({ ...scope }), selection: Object.freeze({ selectedSessionId: scope.sessionId }), theme: Object.freeze({}), storage: Object.freeze(storage), documents: Object.freeze({ read, subscribe }) });
  }

  private poller(extensionId: string, documentId: string, scope: ContextViewScope, viewId: string, key: string): SharedDocumentPoller {
    let poller = this.pollers.get(key);
    if (!poller) {
      poller = new SharedDocumentPoller({ read: signal => this.readDocument(extensionId, documentId, scope, signal) });
      this.pollers.set(key, poller);
    }
    const counts = this.pollerViewCounts.get(key) ?? new Map<string, number>();
    counts.set(viewId, (counts.get(viewId) ?? 0) + 1);
    this.pollerViewCounts.set(key, counts);
    const keys = this.viewPollerKeys.get(viewId) ?? new Set<string>();
    keys.add(key);
    this.viewPollerKeys.set(viewId, keys);
    this.pausePoller(key);
    return poller;
  }

  private async readDocument(extensionId: string, documentId: string, scope: ContextViewScope, signal: AbortSignal): Promise<{ document: unknown | null; revision: number }> {
    const selected = this.currentScope;
    if (!selected || selected.sessionId !== scope.sessionId || this.currentInstallationId !== scope.installationId) throw new Error("stale extension scope");
    const url = `/api/extensions/documents/${encodeURIComponent(extensionId)}/${encodeURIComponent(documentId)}?session=${encodeURIComponent(scope.sessionId)}`;
    const response = await (this.options.authFetch ?? browserAuthFetch)(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error("extension document unavailable");
    const value = parseDocumentEnvelope(await response.json());
    if (value.installationId !== scope.installationId || value.scopeSessionId !== scope.sessionId || value.extensionId !== extensionId || value.documentId !== documentId) throw new Error("extension document identity mismatch");
    return { document: value.document, revision: value.revision };
  }

  private setViewVisible(viewId: string, visible: boolean): void {
    if (visible) this.visibleViews.add(viewId); else this.visibleViews.delete(viewId);
    for (const key of this.viewPollerKeys.get(viewId) ?? []) this.pausePoller(key);
  }
  private onDocumentVisibility = (): void => this.pausePollers();
  private pausePollers(): void { for (const key of this.pollers.keys()) this.pausePoller(key); }
  private pausePoller(key: string): void {
    const hasVisibleSubscriber = [...(this.pollerViewCounts.get(key)?.keys() ?? [])].some(viewId => this.visibleViews.has(viewId));
    this.pollers.get(key)?.setPaused(document.visibilityState !== "visible" || !hasVisibleSubscriber);
  }
  private unlinkPollerView(key: string, viewId: string): void {
    const counts = this.pollerViewCounts.get(key);
    if (counts) {
      const remaining = (counts.get(viewId) ?? 1) - 1;
      if (remaining > 0) counts.set(viewId, remaining); else counts.delete(viewId);
      if (counts.size === 0) this.pollerViewCounts.delete(key);
    }
    const keys = this.viewPollerKeys.get(viewId);
    keys?.delete(key);
    if (keys?.size === 0) this.viewPollerKeys.delete(viewId);
    this.pausePoller(key);
  }
  private cleanupPackage(extensionId: string): void { const loaded = this.loaded.get(extensionId); if (!loaded) return; this.loaded.delete(extensionId); loaded.cleanup(); }
  private cleanupAll(): void {
    for (const id of [...this.loaded.keys()]) this.cleanupPackage(id);
    for (const poller of this.pollers.values()) poller.dispose();
    this.pollers.clear(); this.pollerViewCounts.clear(); this.viewPollerKeys.clear(); this.visibleViews.clear();
  }
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
