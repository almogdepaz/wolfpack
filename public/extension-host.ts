import { ExtensionContributionGate } from "../src/extensions/contribution-contract.ts";
import { isExtensionIdentifier } from "../src/extensions/contribution-metadata.ts";
import type { TerminalLayoutContribution } from "../src/extensions/layout-contract.ts";
import type { ExtensionRegistration, ExtensionViewContext } from "../src/extensions/sdk.ts";
import type { ExtensionCatalogEnvelope, ExtensionCatalogInstallation, ExtensionDocumentReadEnvelope } from "../src/extensions/runtime-contract.ts";
import { browserAuthFetch } from "./browser-auth.ts";
import { contextScopeHint, ContextViewRegistry, type ContextViewScope } from "./context-view-registry.ts";
import { SharedDocumentPoller } from "./extension-document-polling.ts";
import { loadAuthenticatedExtensionBundle } from "./extension-loader.ts";
import { WidgetLayout, type WidgetArea } from "./widget-layout.ts";
import { WidgetPanels, type WidgetPresentation, type NativeWorkspacePanel } from "./widget-panels.ts";

export interface SelectedExtensionScope { readonly sessionId: string | null; readonly unavailable?: string; }
export interface ExtensionLayoutUnregisterOptions { readonly preservePreference?: boolean; }
export interface ExtensionHostOptions {
  readonly container: HTMLElement;
  readonly scope: () => SelectedExtensionScope | null;
  readonly safeMode?: () => boolean;
  readonly registerLayout?: (contribution: TerminalLayoutContribution) => ((options?: ExtensionLayoutUnregisterOptions) => void);
  readonly onCatalogReady?: () => void;
  readonly widgetVisible?: (installation: ExtensionCatalogInstallation) => boolean;
  readonly widgetLayout?: WidgetLayout;
  readonly onWidgetAreasChange?: (areas: readonly WidgetArea[]) => void;
  readonly onWidgetFocus?: (area: WidgetArea | null) => void;
  readonly nativePanels?: readonly NativeWorkspacePanel[];
  readonly onPanelGeometryChange?: () => void;
  readonly authFetch?: typeof browserAuthFetch;
  readonly bundleLoader?: typeof loadAuthenticatedExtensionBundle;
  readonly onChange?: () => void;
}

interface LoadedPackage { readonly fingerprint: string; readonly cleanup: (options?: { readonly preserveLayoutPreference?: boolean }) => void; }
interface ViewOwner { readonly extension: ExtensionCatalogInstallation; readonly unregister: () => void; }
type DocumentPollState = "fresh" | "stale" | "paused" | "error";

type JsonRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function keyFor(installationId: string, extensionId: string, scopeId: string, suffix: string): string {
  return `wolfpack-extension-ui:v1:${installationId}:${extensionId}:${scopeId}:${suffix}`;
}
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string"; }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function safeRelativeAssetPath(value: unknown): value is string { return text(value) && value.length <= 256 && /^[A-Za-z0-9._@+/-]+$/.test(value) && !value.split("/").some(part => !part || part === "." || part === ".."); }
function nonNegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function catalogFailure(): never { throw new Error("invalid extension catalog envelope"); }

/** Treat server JSON as hostile until every identity used for storage or loading is checked. */
export function parseExtensionCatalog(value: unknown): ExtensionCatalogEnvelope {
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
      if (!record(candidate.ui) || !safeRelativeAssetPath(candidate.ui.path) || !text(candidate.ui.url) || candidate.ui.url !== `/api/extensions/assets/${candidate.extensionId}/${candidate.package.digest}/${candidate.ui.path}` || !text(candidate.ui.digest) || !SHA256.test(candidate.ui.digest) || candidate.ui.mime !== "text/javascript") return catalogFailure();
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
  private readonly pollerReaderViewCounts = new Map<string, Map<string, number>>();
  private readonly viewPollerKeys = new Map<string, Set<string>>();
  /** Document keys observed by each mounted view, including one-shot reads. */
  private readonly viewDocumentKeys = new Map<string, Set<string>>();
  private readonly visibleViews = new Set<string>();
  private readonly documentStates = new Map<string, DocumentPollState>();
  private generation = 0;
  private currentScope: SelectedExtensionScope | null = null;
  private currentInstallationId: string | null = null;
  private catalog: ExtensionCatalogEnvelope | null = null;
  private readonly panels: WidgetPanels;
  private shellVisible = true;
  private disposed = false;

  constructor(private readonly options: ExtensionHostOptions) {
    this.registry = new ContextViewRegistry({
      container: options.container,
      createContext: (scope, signal, viewId) => this.contextFor(scope, signal, viewId),
      createContainer: (entry, wrapper, signal) => this.panels.createContainer(entry, wrapper, signal),
      onVisibilityChange: (viewId, visible) => this.setViewVisible(viewId, visible),
      onChange: () => this.render(),
    });
    this.panels = new WidgetPanels({
      container: options.container, registry: this.registry,
      layout: options.widgetLayout ?? new WidgetLayout({ getItem: () => null, setItem: () => {} }),
      onAreasChange: options.onWidgetAreasChange, onFocus: options.onWidgetFocus, onSelect: id => this.select(id),
      nativePanels: options.nativePanels, onGeometryChange: options.onPanelGeometryChange,
      onMove: (id, area) => this.moveWidget(id, area),
    });
    document.addEventListener("visibilitychange", this.onDocumentVisibility);
  }

  get diagnostic(): string { return this.registry.diagnostic; }
  get selectedId(): string | null { return this.panels.selectedId; }
  get availablePanels(): readonly { id: string; title: string }[] { return this.panels.availablePanels; }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.catalog = null;
    const scope = this.options.scope();
    const previousScope = this.currentScope;
    if (previousScope?.sessionId !== scope?.sessionId) {
      // Exact document/view scope changes immediately release their mounted and
      // polling resources, but installed package/layout registrations belong to
      // the catalog installation and remain stable across ordinary pane focus.
      this.registry.setScope(null);
      this.cleanupScopeResources();
    }
    this.currentScope = scope;
    if (!scope || !scope.sessionId || scope.unavailable) {
      this.registry.setScope(null);
      this.cleanupScopeResources();
      this.render(scope?.unavailable ?? contextScopeHint());
      return;
    }
    if (this.options.safeMode?.()) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
    try {
      const response = await (this.options.authFetch ?? browserAuthFetch)("/api/extensions", { cache: "no-store" });
      if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
      const catalog = parseExtensionCatalog(await response.json());
      if (this.disposed || generation !== this.generation) return;
      if (catalog.safeMode) { this.registry.setScope(null); this.cleanupAll(); this.render("Safe mode prevents extension loading."); return; }
      const installationId = catalog.installations[0]?.installationId ?? null;
      // A changed installation owns different trusted registrations. Ordinary
      // session scope changes were already cleaned above without unregistering
      // this installation's stable package/layout contributions.
      if (this.currentInstallationId !== installationId) {
        this.registry.setScope(null);
        this.cleanupAll();
      }
      this.currentInstallationId = installationId;
      this.registry.setScope(installationId ? { installationId, sessionId: scope.sessionId } : null);
      const active = new Set(catalog.installations.filter(item => item.enabled && item.ui).map(item => item.extensionId));
      for (const id of [...this.loaded.keys()]) if (!active.has(id)) this.cleanupPackage(id);
      for (const item of catalog.installations) if (item.enabled && item.ui) await this.load(item, generation);
      if (generation === this.generation) {
        this.catalog = catalog;
        try { this.options.onCatalogReady?.(); } catch {}
        this.render();
      }
    } catch {
      if (generation === this.generation) {
        this.registry.setScope(null);
        this.cleanupScopeResources();
        this.render("Extension catalog unavailable for the selected scope.");
      }
    }
  }

  /** The host may explicitly open a sole view after catalog loading; registration stays inert. */
  select(id?: string): void {
    if (id === undefined) {
      if (!this.catalog || !this.shellVisible) return;
      this.render();
      this.panels.selectDefaults();
      return;
    }
    const owner = this.owners.get(id)?.extension;
    if (owner && this.options.widgetVisible?.(owner) === false) return;
    this.render();
    this.panels.select(id);
  }
  setNativePanels(ids: readonly string[]): void { this.panels.setNativePanels(ids); this.select(); }
  moveWidget(id: string, area: WidgetArea): void { this.panels.move(id, area); this.select(); }
  resetWorkspaceLayout(): void { this.panels.reset(); this.select(); }
  setPresentation(presentation: WidgetPresentation): boolean {
    const visibilityChanged = this.setShellVisible(presentation.visible);
    const presentationChanged = this.panels.setPresentation(presentation);
    return visibilityChanged || presentationChanged;
  }
  /** Hide only widget views: retain controllers and all terminal-layout registrations. */
  syncWidgetVisibility(): void {
    if (this.disposed) return;
    this.render();
    this.select();
  }
  private availableViews() {
    return this.registry.entries().filter(entry => {
      const owner = this.owners.get(entry.id)?.extension;
      return owner && (this.options.widgetVisible?.(owner) ?? true);
    });
  }
  setShellVisible(visible: boolean): boolean {
    if (this.disposed || this.shellVisible === visible) return false;
    this.shellVisible = visible;
    this.panels.setVisible(visible);
    this.pausePollers();
    return true;
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; ++this.generation; document.removeEventListener("visibilitychange", this.onDocumentVisibility); this.cleanupAll(true); this.registry.dispose(); }

  private async load(item: ExtensionCatalogInstallation, generation: number): Promise<void> {
    const existing = this.loaded.get(item.extensionId);
    const fingerprint = packageFingerprint(item);
    if (existing?.fingerprint === fingerprint) return;
    if (existing) this.cleanupPackage(item.extensionId);
    const cleanups: Array<() => void> = [];
    const layoutCleanups: Array<(options?: ExtensionLayoutUnregisterOptions) => void> = [];
    let registrationOpen = true;
    let cleaned = false;
    const cleanup = (options: { readonly preserveLayoutPreference?: boolean } = {}) => {
      if (cleaned) return;
      cleaned = true;
      registrationOpen = false;
      while (cleanups.length > 0) {
        const callback = cleanups.pop()!;
        try { callback(); } catch {}
      }
      while (layoutCleanups.length > 0) {
        const callback = layoutCleanups.pop()!;
        try { callback({ preservePreference: options.preserveLayoutPreference }); } catch {}
      }
    };
    const requireActiveRegistration = (): void => {
      if (!registrationOpen || this.disposed || generation !== this.generation) throw new Error("extension registration is no longer active");
    };
    try {
      const module = await (this.options.bundleLoader ?? loadAuthenticatedExtensionBundle)<{ default?: ExtensionRegistration }>(item.ui!.url, item.ui!.digest, { safeMode: false });
      if (this.disposed || generation !== this.generation) return;
      if (typeof module.default !== "function") throw new Error("extension bundle has no registration function");
      const gate = new ExtensionContributionGate(item.extensionId);
      const registrationCleanup = module.default({
        registerContextView: contribution => {
          requireActiveRegistration();
          const viewId = gate.register("context-view", contribution.id).qualifiedId;
          const unregister = this.registry.register(viewId, contribution);
          this.owners.set(viewId, { extension: item, unregister });
          cleanups.push(() => { this.owners.delete(viewId); unregister(); });
        },
        registerTerminalLayout: contribution => {
          requireActiveRegistration();
          const qualifiedId = gate.register("terminal-layout", contribution.id).qualifiedId;
          // Layout integration is injected by app.ts; errors are contained with this package.
          const unregister = this.options.registerLayout?.({ ...contribution, id: qualifiedId }) ?? (() => {});
          layoutCleanups.push(unregister);
        },
      });
      // The SDK registration surface is deliberately synchronous. Closing it
      // here prevents delayed callbacks from adding contributions even before
      // a later disable/update/dispose transition.
      registrationOpen = false;
      if (typeof registrationCleanup === "function") cleanups.push(registrationCleanup);
      this.loaded.set(item.extensionId, { fingerprint, cleanup });
    } catch {
      registrationOpen = false;
      cleanup();
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
    const read = async (documentId: string): Promise<unknown> => this.readOnce(extensionId, documentId, scope, signal, viewId).then(value => value.document);
    const subscribe = (documentId: string, listener: (value: unknown, revision: number) => void): (() => void) => {
      this.assertDeclaredDocument(owner, documentId);
      const pollerKey = keyFor(scope.installationId, extensionId, scope.sessionId, `document:${documentId}`);
      this.linkDocumentView(viewId, pollerKey);
      const poller = this.poller(extensionId, documentId, scope, viewId, pollerKey);
      let unsubscribe: () => void;
      try { unsubscribe = poller.subscribe(listener); }
      catch (error) {
        this.unlinkPollerView(pollerKey, viewId);
        throw error;
      }
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
    signal.addEventListener("abort", () => this.releaseViewDocuments(viewId), { once: true });
    return Object.freeze({ signal, scope: Object.freeze({ ...scope }), selection: Object.freeze({ selectedSessionId: scope.sessionId }), theme: Object.freeze({}), storage: Object.freeze(storage), documents: Object.freeze({ read, subscribe }) });
  }

  private assertDeclaredDocument(owner: ExtensionCatalogInstallation | undefined, documentId: string): void {
    if (!owner?.documents.some(document => document.id === documentId)) throw new Error("extension document is not declared by this package");
  }
  private pollerFor(extensionId: string, documentId: string, scope: ContextViewScope, key: string): SharedDocumentPoller {
    let poller = this.pollers.get(key);
    if (!poller) {
      poller = new SharedDocumentPoller({
        read: signal => this.readDocument(extensionId, documentId, scope, signal),
        onState: state => {
          this.documentStates.set(key, state);
          this.render();
        },
      });
      this.pollers.set(key, poller);
    }
    return poller;
  }
  private poller(extensionId: string, documentId: string, scope: ContextViewScope, viewId: string, key: string): SharedDocumentPoller {
    const poller = this.pollerFor(extensionId, documentId, scope, key);
    const counts = this.pollerViewCounts.get(key) ?? new Map<string, number>();
    counts.set(viewId, (counts.get(viewId) ?? 0) + 1);
    this.pollerViewCounts.set(key, counts);
    const keys = this.viewPollerKeys.get(viewId) ?? new Set<string>();
    keys.add(key);
    this.viewPollerKeys.set(viewId, keys);
    this.pausePoller(key);
    return poller;
  }
  private readOnce(extensionId: string, documentId: string, scope: ContextViewScope, signal: AbortSignal, viewId: string): Promise<{ document: unknown | null; revision: number }> {
    const owner = [...this.owners.values()].find(candidate => candidate.extension.extensionId === extensionId)?.extension;
    this.assertDeclaredDocument(owner, documentId);
    const key = keyFor(scope.installationId, extensionId, scope.sessionId, `document:${documentId}`);
    this.linkDocumentView(viewId, key);
    const poller = this.pollerFor(extensionId, documentId, scope, key);
    this.linkPollerReader(key, viewId);
    const read = poller.readOnce(signal);
    this.pausePoller(key);
    return read.finally(() => this.unlinkPollerReader(key, viewId));
  }
  private linkDocumentView(viewId: string, key: string): void {
    const keys = this.viewDocumentKeys.get(viewId) ?? new Set<string>();
    keys.add(key);
    this.viewDocumentKeys.set(viewId, keys);
  }
  private linkPollerReader(key: string, viewId: string): void {
    const counts = this.pollerReaderViewCounts.get(key) ?? new Map<string, number>();
    counts.set(viewId, (counts.get(viewId) ?? 0) + 1);
    this.pollerReaderViewCounts.set(key, counts);
  }
  private unlinkPollerReader(key: string, viewId: string): void {
    const counts = this.pollerReaderViewCounts.get(key);
    if (counts) {
      const remaining = Math.max(0, (counts.get(viewId) ?? 1) - 1);
      if (remaining > 0) counts.set(viewId, remaining); else counts.delete(viewId);
      if (counts.size === 0) this.pollerReaderViewCounts.delete(key);
    }
    this.releasePollerIfUnowned(key);
  }

  private scopeIsCurrent(scope: ContextViewScope, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && this.currentScope?.sessionId === scope.sessionId && this.currentInstallationId === scope.installationId;
  }
  private async readDocument(extensionId: string, documentId: string, scope: ContextViewScope, signal: AbortSignal): Promise<{ document: unknown | null; revision: number }> {
    if (!this.scopeIsCurrent(scope, signal)) throw new Error("stale extension scope");
    const url = `/api/extensions/documents/${encodeURIComponent(extensionId)}/${encodeURIComponent(documentId)}?session=${encodeURIComponent(scope.sessionId)}`;
    const response = await (this.options.authFetch ?? browserAuthFetch)(url, { cache: "no-store", signal });
    if (!this.scopeIsCurrent(scope, signal)) throw new Error("stale extension scope");
    if (!response.ok) throw new Error("extension document unavailable");
    const value = parseDocumentEnvelope(await response.json());
    if (!this.scopeIsCurrent(scope, signal)) throw new Error("stale extension scope");
    if (value.installationId !== scope.installationId || value.scopeSessionId !== scope.sessionId || value.extensionId !== extensionId || value.documentId !== documentId) throw new Error("extension document identity mismatch");
    return { document: value.document, revision: value.revision };
  }

  private setViewVisible(viewId: string, visible: boolean): void {
    if (visible) this.visibleViews.add(viewId); else this.visibleViews.delete(viewId);
    for (const key of this.viewDocumentKeys.get(viewId) ?? []) this.pausePoller(key);
  }
  private onDocumentVisibility = (): void => this.pausePollers();
  private pausePollers(): void { for (const key of this.pollers.keys()) this.pausePoller(key); }
  private pausePoller(key: string): void {
    const activeViews = new Set<string>([
      ...(this.pollerViewCounts.get(key)?.keys() ?? []),
      ...(this.pollerReaderViewCounts.get(key)?.keys() ?? []),
    ]);
    // Historical document interest drives status only. With no active consumer
    // the poller already has no cadence, so do not manufacture a paused state.
    if (activeViews.size === 0) return;
    const hasVisibleConsumer = [...activeViews].some(viewId => this.visibleViews.has(viewId));
    this.pollers.get(key)?.setPaused(document.visibilityState !== "visible" || !this.shellVisible || !hasVisibleConsumer);
  }
  private unlinkPollerView(key: string, viewId: string): void {
    const counts = this.pollerViewCounts.get(key);
    const remainingForView = counts ? Math.max(0, (counts.get(viewId) ?? 1) - 1) : 0;
    if (counts) {
      if (remainingForView > 0) counts.set(viewId, remainingForView); else counts.delete(viewId);
      if (counts.size === 0) this.pollerViewCounts.delete(key);
    }
    const keys = this.viewPollerKeys.get(viewId);
    if (remainingForView === 0) keys?.delete(key);
    if (keys?.size === 0) this.viewPollerKeys.delete(viewId);
    this.releasePollerIfUnowned(key);
  }
  private releaseViewDocuments(viewId: string): void {
    const keys = [...(this.viewDocumentKeys.get(viewId) ?? [])];
    this.viewDocumentKeys.delete(viewId);
    this.visibleViews.delete(viewId);
    for (const key of keys) this.releasePollerIfUnowned(key);
  }
  private releasePollerIfUnowned(key: string): void {
    const hasViewOwner = [...this.viewDocumentKeys.values()].some(keys => keys.has(key));
    const poller = this.pollers.get(key);
    if (hasViewOwner || this.pollerViewCounts.has(key) || this.pollerReaderViewCounts.has(key) || poller?.hasActiveConsumers) {
      this.pausePoller(key);
      return;
    }
    poller?.dispose();
    this.pollers.delete(key);
    this.documentStates.delete(key);
  }
  private cleanupPackage(extensionId: string, preserveLayoutPreference = false): void { const loaded = this.loaded.get(extensionId); if (!loaded) return; this.loaded.delete(extensionId); loaded.cleanup({ preserveLayoutPreference }); }
  private cleanupScopeResources(): void {
    for (const poller of this.pollers.values()) poller.dispose();
    this.pollers.clear(); this.pollerViewCounts.clear(); this.pollerReaderViewCounts.clear(); this.viewPollerKeys.clear(); this.viewDocumentKeys.clear(); this.visibleViews.clear(); this.documentStates.clear();
  }
  private cleanupAll(preserveLayoutPreference = false): void {
    for (const id of [...this.loaded.keys()]) this.cleanupPackage(id, preserveLayoutPreference);
    this.cleanupScopeResources();
  }
  private render(message = this.registry.diagnostic): void {
    const entries = this.availableViews();
    this.panels.update(entries, message || (!entries.length && this.registry.entries().length ? "Widgets are hidden. Manage widgets in Settings." : ""), id => this.selectedDocumentStatus(id));
    this.options.onChange?.();
  }
  private selectedDocumentStatus(selected: string): string | null {
    const states = [...(this.viewDocumentKeys.get(selected) ?? [])].map(key => this.documentStates.get(key));
    if (states.includes("error")) return "Extension context data is unavailable.";
    if (states.includes("stale")) return "Showing stale extension context data.";
    if (states.includes("paused")) return "Extension context updates are paused.";
    return null;
  }
}
