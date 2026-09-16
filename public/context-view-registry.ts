import type { ContextViewContribution, ContextViewController, ExtensionViewContext } from "../src/extensions/sdk.ts";

export interface ContextViewScope {
  readonly installationId: string;
  readonly sessionId: string;
}

export interface ContextViewRegistryOptions {
  readonly container: HTMLElement;
  readonly maxRetainedViews?: number;
  readonly createContext?: (scope: ContextViewScope, signal: AbortSignal, viewId: string) => ExtensionViewContext;
  readonly onChange?: () => void;
  readonly onVisibilityChange?: (viewId: string, visible: boolean) => void;
}

export interface RegisteredContextView {
  readonly id: string;
  readonly contribution: ContextViewContribution;
}

interface MountedContextView {
  readonly id: string;
  readonly element: HTMLElement;
  readonly controller: ContextViewController;
  readonly abort: AbortController;
  disposed: boolean;
}

const MAX_RETAINED_CONTEXT_VIEWS = 32;

/**
 * Host-owned context-view lifecycle. It owns each wrapper and never lets package
 * code replace workspace/editor/terminal nodes. Registration alone is inert;
 * selection performs the first mount, and scope replacement aborts then disposes
 * every old controller before a new scope can mount.
 */
export class ContextViewRegistry {
  private readonly entriesById = new Map<string, RegisteredContextView>();
  private readonly mountedById = new Map<string, MountedContextView>();
  private readonly maxRetainedViews: number;
  private scopeValue: ContextViewScope | null = null;
  private selectedValue: string | null = null;
  private diagnosticValue = "";

  constructor(private readonly options: ContextViewRegistryOptions) {
    const requested = options.maxRetainedViews ?? MAX_RETAINED_CONTEXT_VIEWS;
    this.maxRetainedViews = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, MAX_RETAINED_CONTEXT_VIEWS)
      : MAX_RETAINED_CONTEXT_VIEWS;
  }

  get selectedId(): string | null { return this.selectedValue; }
  get diagnostic(): string { return this.diagnosticValue; }
  get scope(): ContextViewScope | null { return this.scopeValue; }
  entries(): readonly RegisteredContextView[] { return [...this.entriesById.values()]; }

  register(id: string, contribution: ContextViewContribution): () => void {
    if (!id || this.entriesById.has(id)) throw new Error(`duplicate context view registration: ${id}`);
    const entry = Object.freeze({ id, contribution });
    this.entriesById.set(id, entry);
    this.changed();
    return () => {
      if (this.entriesById.get(id) !== entry) return;
      this.entriesById.delete(id);
      this.disposeMounted(id);
      if (this.selectedValue === id) this.selectedValue = null;
      this.changed();
    };
  }

  setScope(scope: ContextViewScope | null): void {
    if (this.scopeValue?.installationId === scope?.installationId && this.scopeValue?.sessionId === scope?.sessionId) {
      // The initial unavailable/error path has no previous scope to replace but
      // still needs host-owned chrome instead of a silent empty region.
      if (!scope && !this.diagnosticValue) {
        this.diagnosticValue = "Select a live terminal with an exact session identity to view extension context.";
        this.changed();
      }
      return;
    }
    this.disposeAllMounted();
    this.scopeValue = scope;
    this.selectedValue = null;
    this.diagnosticValue = scope ? "" : "Select a live terminal with an exact session identity to view extension context.";
    this.changed();
  }

  select(id: string | null): void {
    if (id === null) {
      this.selectedValue = null;
      for (const mounted of this.mountedById.values()) this.setVisible(mounted, false);
      this.changed();
      return;
    }
    const entry = this.entriesById.get(id);
    if (!entry) {
      this.diagnosticValue = "Selected extension view is unavailable.";
      this.changed();
      return;
    }
    if (!this.scopeValue) {
      this.diagnosticValue = "Select a live terminal with an exact session identity to view extension context.";
      this.changed();
      return;
    }
    let mounted: MountedContextView | null | undefined = this.mountedById.get(id);
    if (!mounted) {
      if (this.mountedById.size >= this.maxRetainedViews) {
        this.diagnosticValue = `Cannot open ${entry.contribution.title}: retained view limit (${this.maxRetainedViews}) reached.`;
        this.changed();
        return;
      }
      mounted = this.mount(entry);
      if (!mounted) return;
    }
    for (const item of this.mountedById.values()) this.setVisible(item, item.id === id);
    this.selectedValue = id;
    this.diagnosticValue = "";
    this.changed();
  }

  dispose(): void {
    this.disposeAllMounted();
    this.entriesById.clear();
    this.selectedValue = null;
    this.scopeValue = null;
    this.changed();
  }

  private mount(entry: RegisteredContextView): MountedContextView | null {
    const scope = this.scopeValue;
    if (!scope) return null;
    const element = document.createElement("section");
    element.dataset.contextView = entry.id;
    element.hidden = true;
    const abort = new AbortController();
    try {
      this.options.container.append(element);
      const fallbackContext = Object.freeze({
        signal: abort.signal,
        scope: Object.freeze({ ...scope }),
        selection: Object.freeze({ selectedSessionId: scope.sessionId }),
        theme: Object.freeze({}),
        storage: Object.freeze({ get: () => null, set: () => {}, remove: () => {} }),
        documents: Object.freeze({ read: async () => null, subscribe: () => () => {} }),
      }) as ExtensionViewContext;
      const controller = entry.contribution.mount(element, this.options.createContext?.(scope, abort.signal, entry.id) ?? fallbackContext);
      if (!controller || typeof controller.dispose !== "function") throw new Error("context view mount did not return a controller");
      const mounted: MountedContextView = { id: entry.id, element, controller, abort, disposed: false };
      this.mountedById.set(entry.id, mounted);
      return mounted;
    } catch (error) {
      abort.abort();
      element.remove();
      this.diagnosticValue = `Could not mount ${entry.contribution.title}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`;
      this.changed();
      return null;
    }
  }

  private setVisible(mounted: MountedContextView, visible: boolean): void {
    mounted.element.hidden = !visible;
    try { mounted.controller.setVisible?.(visible); }
    catch { this.diagnosticValue = `Visibility update failed for ${mounted.id}.`; }
    this.options.onVisibilityChange?.(mounted.id, visible);
  }

  private disposeMounted(id: string): void {
    const mounted = this.mountedById.get(id);
    if (!mounted || mounted.disposed) return;
    mounted.disposed = true;
    this.mountedById.delete(id);
    mounted.abort.abort();
    try { mounted.controller.dispose(); }
    catch { this.diagnosticValue = `Cleanup failed for ${id}.`; }
    mounted.element.remove();
  }

  private disposeAllMounted(): void {
    for (const id of [...this.mountedById.keys()]) this.disposeMounted(id);
  }

  private changed(): void { this.options.onChange?.(); }
}
