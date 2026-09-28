import type { ContextViewRegistry, RegisteredContextView } from "./context-view-registry.ts";
import { WidgetLayout, WIDGET_AREAS, type WidgetArea, isNativePanel } from "./widget-layout.ts";

export interface WidgetPresentation {
  readonly visible: boolean;
  readonly desktop: boolean;
  readonly focusArea: WidgetArea | null;
}
export interface NativeWorkspacePanel {
  readonly id: string;
  readonly title: string;
  readonly element: HTMLElement;
}
interface Chrome {
  readonly node: HTMLElement;
  readonly header: HTMLElement;
  readonly title: HTMLButtonElement;
  readonly tabs: HTMLElement;
  readonly buttons: Map<string, HTMLButtonElement>;
  order: string[];
  readonly full: HTMLButtonElement;
  readonly collapse: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly placeholder: HTMLElement;
}

/** Host panels share area chrome, not SDK registrations. Content and terminal roots never move. */
export class WidgetPanels {
  private entries: readonly RegisteredContextView[] = [];
  private readonly slots = new Map<string, HTMLElement>();
  private readonly chrome = new Map<WidgetArea, Chrome>();
  private readonly active: Partial<Record<WidgetArea, string>> = {};
  private readonly errors: Partial<Record<WidgetArea, string>> = {};
  private nativeIds: readonly string[] = [];
  private mobileSelection: string | null = null;
  private lastSelected: string | null = null;
  private presentation: WidgetPresentation = { visible: true, desktop: true, focusArea: null };
  private message = "";
  private documentStatus: (id: string) => string | null = () => null;
  private areasKey = "";
  private placeholderState: "open" | "collapsed" | "closed" = "open";
  private readonly mobileClosed = new Set<string>();
  private rendering = false;
  private selecting = false;

  constructor(private readonly options: {
    readonly container: HTMLElement;
    readonly registry: ContextViewRegistry;
    readonly layout: WidgetLayout;
    readonly nativePanels?: readonly NativeWorkspacePanel[];
    readonly onAreasChange?: (areas: readonly WidgetArea[], collapsed: readonly WidgetArea[]) => void;
    readonly onFocus?: (area: WidgetArea | null) => void;
    readonly onGeometryChange?: () => void;
    readonly onSelect: (id: string) => void;
  }) {
    for (const area of WIDGET_AREAS) this.chrome.set(area, this.createChrome(area));
  }
  get selectedId(): string | null {
    if (!this.presentation.desktop && this.mobileSelection && this.slots.has(this.mobileSelection)) return this.mobileSelection;
    const ids = this.activeIds().filter(id => !isNativePanel(id));
    return this.lastSelected && ids.includes(this.lastSelected) ? this.lastSelected : ids[0] ?? null;
  }
  get availablePanels(): readonly { id: string; title: string }[] { return this.panelEntries(); }
  private native(id: string): NativeWorkspacePanel | undefined { return this.options.nativePanels?.find(panel => panel.id === id); }
  private mounted(id: string): boolean { return this.slots.has(id) || !!this.native(id); }
  private panelEntries(includeHiddenWidgets = false): { id: string; title: string }[] {
    return [
      ...(this.presentation.desktop ? (this.options.nativePanels ?? []).filter(panel => this.nativeIds.includes(panel.id)).map(({ id, title }) => ({ id, title })) : []),
      ...(this.presentation.visible || includeHiddenWidgets ? this.entries.filter(entry => this.presentation.desktop ? this.options.layout.widgetState(entry.id) !== "closed" : !this.mobileClosed.has(entry.id)).map(entry => ({ id: entry.id, title: entry.contribution.title })) : []),
    ];
  }
  private ids(): string[] { return this.panelEntries().map(entry => entry.id); }
  private collapsed(id: string): boolean { return this.presentation.desktop && this.options.layout.widgetState(id) === "collapsed"; }
  reopen(): void {
    if (this.presentation.desktop) { this.options.layout.reopenWidgets(); this.placeholderState = "open"; }
    this.mobileClosed.clear();
    this.render();
  }
  private dismiss(area: WidgetArea, close: boolean): void {
    const id = this.presentation.desktop ? this.active[area] : this.mobileSelection;
    if (id && isNativePanel(id)) return;
    if (!this.presentation.desktop && !close) { this.options.onFocus?.(null); return; }
    if (id) {
      if (this.presentation.desktop) this.options.layout.setWidgetState(id, close ? "closed" : "collapsed");
      else if (close) this.mobileClosed.add(id);
    } else if (this.presentation.desktop) this.placeholderState = close ? "closed" : "collapsed";
    const next = this.panelEntries().find(entry => entry.id !== id && !this.collapsed(entry.id) && (!this.presentation.desktop || this.area(entry.id) === area));
    if (this.presentation.desktop || !next) this.options.onFocus?.(null);
    if (next) this.select(next.id);
    else if (!this.presentation.desktop) this.mobileSelection = null;
    this.render();
    const chrome = this.chrome.get(area)!;
    const target = (!close ? chrome.buttons.get(id ?? "") : next ? chrome.buttons.get(next.id) : null);
    if (target?.isConnected && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else for (const control of document.querySelectorAll<HTMLElement>("#workspace-restore, #sidebar-settings-btn, #gear-btn")) {
      if (control.getClientRects().length) { control.focus({ preventScroll: true }); break; }
    }
  }
  private area(id: string): WidgetArea { return this.options.layout.areasFor(this.ids())[id] ?? this.options.layout.area(id); }
  setNativePanels(ids: readonly string[]): void {
    const valid = (this.options.nativePanels ?? []).filter(panel => ids.includes(panel.id)).map(panel => panel.id);
    if (valid.join() === this.nativeIds.join()) return;
    this.nativeIds = valid;
    this.render();
  }
  createContainer(entry: RegisteredContextView, wrapper: HTMLElement, signal: AbortSignal): HTMLElement {
    wrapper.className = "widget-panel";
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `${entry.contribution.title} widget`);
    wrapper.dataset.widgetArea = this.area(entry.id);
    const body = document.createElement("div");
    body.className = "widget-content";
    const content = document.createElement("div");
    delete wrapper.dataset.contextView;
    content.dataset.contextView = entry.id;
    content.id = `widget-view-${encodeURIComponent(entry.id)}`;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-label", entry.contribution.title);
    body.append(content); wrapper.append(body);
    this.slots.set(entry.id, wrapper);
    signal.addEventListener("abort", () => {
      if (this.slots.get(entry.id) !== wrapper) return;
      this.slots.delete(entry.id);
      for (const area of WIDGET_AREAS) if (this.active[area] === entry.id) delete this.active[area];
      if (this.mobileSelection === entry.id) this.mobileSelection = null;
    }, { once: true });
    return content;
  }
  update(entries: readonly RegisteredContextView[], message: string, documentStatus: (id: string) => string | null): void {
    this.entries = entries; this.message = message; this.documentStatus = documentStatus;
    if (!entries.some(entry => entry.id === this.mobileSelection)) this.mobileSelection = null;
    this.render();
  }
  setPresentation(next: WidgetPresentation): boolean {
    const previous = this.presentation;
    if (previous.visible === next.visible && previous.desktop === next.desktop && previous.focusArea === next.focusArea) return false;
    if (previous.desktop !== next.desktop) { this.mobileSelection = null; this.mobileClosed.clear(); }
    this.presentation = next;
    this.render();
    return true;
  }
  setVisible(visible: boolean): void { this.setPresentation({ ...this.presentation, visible }); }
  select(id: string, persist = true): void {
    if (!this.ids().includes(id)) {
      if (!isNativePanel(id) && !this.entries.some(entry => entry.id === id)) this.options.registry.select(id);
      return;
    }
    const area = this.area(id);
    // Mount transactionally: failure cannot hide/pause a healthy current tab.
    if (!isNativePanel(id)) {
      this.selecting = true;
      try {
        const keep = this.presentation.desktop ? this.visibleIds().filter(other => !isNativePanel(other) && this.area(other) !== area) : [];
        this.options.registry.select(id, keep);
      } finally { this.selecting = false; }
      if (this.options.registry.selectedId !== id) { this.errors[area] = this.options.registry.diagnostic; this.render(); return; }
    }
    if (this.collapsed(id)) this.options.layout.setWidgetState(id, "open");
    if (this.presentation.desktop) this.active[area] = id; else this.mobileSelection = id;
    this.lastSelected = id;
    delete this.errors[area];
    if (persist && this.presentation.desktop) this.options.layout.select(id);
    this.render();
  }
  /** Caller owns complete-catalog and visible-shell gates for extension mounting. */
  selectDefaults(): void {
    if (!this.presentation.visible) return;
    const ids = this.ids();
    if (!this.presentation.desktop) {
      const id = this.mobileSelection ?? this.selectedId ?? (ids.length === 1 ? ids[0]! : null);
      if (id && !this.mobileSelection) this.select(id, false);
      return;
    }
    for (const area of this.visibleAreas()) {
      const saved = this.options.layout.selection(area, ids);
      const id = saved && this.collapsed(saved) ? ids.find(other => this.area(other) === area && !this.collapsed(other)) : saved;
      if (id && id !== this.active[area]) this.select(id, false);
    }
  }
  move(id: string, area: WidgetArea): void {
    // An empty diagnostic panel changes host geometry only, never registry membership.
    if (!id && this.presentation.desktop && this.presentation.visible && !this.entries.length) {
      this.options.layout.setDefaultArea(area); this.options.onFocus?.(null); this.render(); return;
    }
    if (!this.presentation.desktop || !this.mounted(id) || !this.ids().includes(id)) return;
    const from = this.area(id);
    const ids = this.ids();
    if (!this.options.layout.move(id, area, ids)) { this.render(); return; }
    if (this.active[from] === id) delete this.active[from];
    for (const location of WIDGET_AREAS) {
      const selected = this.options.layout.selection(location, ids);
      if (selected && this.mounted(selected)) this.active[location] = selected;
    }
    this.active[area] = id;
    this.lastSelected = id;
    this.options.onFocus?.(null);
    this.render();
  }
  reset(): void {
    const selected = this.selectedId;
    this.options.layout.reset(); this.placeholderState = "open"; this.mobileClosed.clear();
    for (const area of WIDGET_AREAS) delete this.active[area];
    if (selected && this.slots.has(selected)) this.active.right = selected;
    this.render();
  }
  private activeIds(): string[] { return WIDGET_AREAS.flatMap(area => this.active[area] && this.mounted(this.active[area]!) ? [this.active[area]!] : []); }
  private occupiedAreas(): WidgetArea[] {
    const ids = this.ids();
    const areas = WIDGET_AREAS.filter(area => ids.some(id => this.area(id) === area));
    // A diagnostic placeholder remains useful when no extensions are available.
    if (!this.entries.length && this.placeholderState !== "closed" && this.presentation.visible && !areas.includes(this.options.layout.area(""))) areas.push(this.options.layout.area(""));
    return areas;
  }
  private visibleAreas(): readonly WidgetArea[] {
    const areas = this.occupiedAreas();
    return this.presentation.focusArea ? [areas.includes(this.presentation.focusArea) ? this.presentation.focusArea : areas[0]!] : areas;
  }
  private visibleIds(): string[] {
    if (!this.presentation.desktop) return this.presentation.visible && this.mobileSelection && !this.mobileClosed.has(this.mobileSelection) && this.slots.has(this.mobileSelection) ? [this.mobileSelection] : [];
    return this.visibleAreas().flatMap(area => this.active[area] && !this.collapsed(this.active[area]!) && this.ids().includes(this.active[area]!) && this.mounted(this.active[area]!) ? [this.active[area]!] : []);
  }
  private createChrome(area: WidgetArea): Chrome {
    const label = area[0]!.toUpperCase() + area.slice(1);
    const placeholder = document.createElement("section");
    placeholder.className = "widget-panel"; placeholder.dataset.widgetArea = area;
    placeholder.setAttribute("role", "region"); placeholder.setAttribute("aria-label", `${label} widgets`);
    const node = document.createElement("div"); node.className = "widget-chrome";
    const header = document.createElement("header"); header.className = "workspace-context-header";
    const title = document.createElement("button"); title.type = "button";
    title.setAttribute("aria-describedby", "workspace-dock-help");
    const actions = document.createElement("div"); actions.className = "workspace-context-actions";
    const full = document.createElement("button"); full.type = "button"; full.dataset.widgetFull = ""; full.className = "workspace-icon";
    full.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path class="expand-icon" d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><path class="restore-icon" d="M8 3v5H3m13-5v5h5M3 16h5v5m8 0v-5h5"/></svg>';
    full.addEventListener("click", () => this.options.onFocus?.(this.presentation.focusArea ? null : area));
    const collapse = document.createElement("button"); collapse.type = "button"; collapse.className = "workspace-icon"; collapse.textContent = "−";
    collapse.addEventListener("click", () => this.dismiss(area, false));
    const close = document.createElement("button"); close.type = "button"; close.className = "workspace-icon"; close.textContent = "×";
    close.addEventListener("click", () => this.dismiss(area, true));
    actions.append(full, collapse, close); header.append(title); header.append(actions);
    const tabs = document.createElement("div"); tabs.dataset.extensionTabs = ""; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", `${label} widgets`);
    const status = document.createElement("p"); status.dataset.extensionStatus = ""; status.setAttribute("role", "status");
    const geometryStatus = document.createElement("p"); geometryStatus.dataset.workspaceLayoutStatus = ""; geometryStatus.setAttribute("role", "status"); geometryStatus.hidden = true;
    node.append(header); node.append(tabs); node.append(status); node.append(geometryStatus); placeholder.append(node);
    return { node, header, title, tabs, buttons: new Map(), order: [], full, collapse, close, status, placeholder };
  }
  private render(): void {
    if (this.rendering || this.selecting) return;
    this.rendering = true;
    try {
      const ids = this.ids();
      if (this.presentation.desktop) for (const area of WIDGET_AREAS) {
        if (!ids.some(id => id === this.active[area] && this.area(id) === area)) delete this.active[area];
        // Built-ins never wait for an extension catalog and never use the SDK registry.
        if (!this.active[area]) {
          const saved = this.options.layout.selection(area, ids);
          const retained = saved && this.mounted(saved) ? saved : ids.find(id => isNativePanel(id) && this.area(id) === area);
          if (retained) this.active[area] = retained;
        }
      }
      const areas = this.occupiedAreas();
      const collapsedAreas = this.presentation.desktop ? areas.filter(area => {
        const members = ids.filter(id => this.area(id) === area);
        return members.length ? members.every(id => this.collapsed(id)) : this.placeholderState === "collapsed";
      }) : [];
      const key = `${areas.join(",")}/${collapsedAreas.join(",")}`;
      if (key !== this.areasKey) { this.areasKey = key; this.options.onAreasChange?.(areas, collapsedAreas); }
      for (const [id, slot] of this.slots) slot.dataset.widgetArea = this.area(id);
      const visibleIds = this.visibleIds();
      this.options.registry.setVisibleIds(visibleIds.filter(id => !isNativePanel(id)));
      for (const [id, slot] of this.slots) {
        const collapsed = this.collapsed(id);
        slot.dataset.collapsed = String(collapsed);
        const body = slot.querySelector<HTMLElement>(".widget-content");
        if (body) body.hidden = collapsed;
        const showCollapsed = collapsed && this.active[this.area(id)] === id && this.presentation.visible && this.visibleAreas().includes(this.area(id));
        slot.hidden = !visibleIds.includes(id) && !showCollapsed;
      }
      for (const panel of this.options.nativePanels ?? []) {
        panel.element.dataset.widgetArea = this.area(panel.id);
        const hidden = this.presentation.desktop && this.nativeIds.includes(panel.id) && !visibleIds.includes(panel.id);
        if (panel.element.hidden !== hidden) { panel.element.hidden = hidden; this.options.onGeometryChange?.(); }
      }
      const mobileArea = this.mobileSelection ? this.area(this.mobileSelection) : areas[0] ?? this.options.layout.area(this.entries[0]?.id ?? "");
      for (const area of WIDGET_AREAS) {
        const chrome = this.chrome.get(area)!;
        if (areas.includes(area) || this.entries.some(entry => this.options.layout.area(entry.id) === area)) { if (!chrome.placeholder.parentElement) this.options.container.append(chrome.placeholder); }
        else chrome.placeholder.remove();
        const selected = this.presentation.desktop ? this.active[area] : area === mobileArea ? this.mobileSelection : null;
        const target = selected ? this.native(selected)?.element ?? this.slots.get(selected) ?? chrome.placeholder : chrome.placeholder;
        const focus = document.activeElement as HTMLElement | null;
        const hadFocus = focus && chrome.node.contains(focus);
        const pool = this.panelEntries(!selected || !isNativePanel(selected));
        const entries = this.presentation.desktop ? pool.filter(entry => this.area(entry.id) === area) : area === mobileArea ? pool : [];
        if (selected && isNativePanel(selected) && entries.length === 1 && !this.options.layout.diagnostic) chrome.node.remove();
        else if (chrome.node.parentElement !== target) { target.prepend(chrome.node); if (hadFocus) focus.focus({ preventScroll: true }); }
        chrome.placeholder.hidden = target !== chrome.placeholder || !this.presentation.visible || (this.presentation.desktop ? !this.visibleAreas().includes(area) : area !== mobileArea);
        const entry = entries.find(entry => entry.id === selected);
        const collapsed = collapsedAreas.includes(area);
        target.dataset.collapsed = String(collapsed);
        chrome.header.hidden = (!!selected && isNativePanel(selected)) || collapsed;
        chrome.title.textContent = `⠿ ${entry?.title ?? "Widgets"}`;
        chrome.title.dataset.dockHandle = selected ?? "";
        chrome.title.disabled = !entry && this.entries.length > 0;
        chrome.title.setAttribute("aria-label", `Move ${entry?.title ?? "Widgets"}`);
        chrome.title.title = `Drag ${entry?.title ?? "Widgets"} to dock`;
        chrome.full.hidden = !this.presentation.desktop || (!!selected && isNativePanel(selected));
        chrome.collapse.setAttribute("aria-label", chrome.collapse.title = `Collapse ${entry?.title ?? "Widgets"}`);
        chrome.close.setAttribute("aria-label", chrome.close.title = `Close ${entry?.title ?? "Widgets"}`);
        chrome.full.setAttribute("aria-label", chrome.full.title = this.presentation.focusArea ? "Restore workspace" : "Context full view");
        chrome.full.setAttribute("aria-pressed", String(!!this.presentation.focusArea));
        chrome.status.textContent = this.options.layout.diagnostic || (selected && isNativePanel(selected) ? "" : this.message || this.errors[area] || (selected ? this.documentStatus(selected) : entries.length ? "Select a context view." : "No enabled context views for this scope.")) || "";
        // Native headers need a grip, not empty SDK status/tab owners.
        if (selected && isNativePanel(selected) && !chrome.status.textContent) chrome.status.remove();
        else if (!chrome.status.parentElement) chrome.node.append(chrome.status);
        if (selected && isNativePanel(selected) && entries.length < 2) chrome.tabs.remove();
        else if (!chrome.tabs.parentElement) chrome.node.insertBefore(chrome.tabs, chrome.status.parentElement ? chrome.status : null);
        chrome.tabs.hidden = !collapsed && entries.length < 2 && (!entries.length || !!selected);
        // A collapsed empty diagnostic panel still has a local recovery affordance.
        if (collapsed && !entries.length) entries.push({ id: "", title: "Widgets" });
        chrome.tabs.setAttribute("aria-label", `${area[0]!.toUpperCase() + area.slice(1)} ${entries.some(entry => isNativePanel(entry.id)) ? "panels" : "widgets"}`);
        for (const [id, button] of chrome.buttons) if (!entries.some(entry => entry.id === id)) { button.remove(); chrome.buttons.delete(id); }
        chrome.order = entries.map(entry => entry.id);
        for (const [index, item] of entries.entries()) {
          let button = chrome.buttons.get(item.id);
          if (!button) {
            button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "tab");
            const activate = (id: string) => {
              this.options.onSelect(id);
              const current = this.chrome.get(this.area(id));
              (current?.tabs.hidden ? current.collapse : current?.buttons.get(id))?.focus({ preventScroll: true });
            };
            button.addEventListener("click", () => {
              if (!item.id) { this.placeholderState = "open"; this.render(); chrome.collapse.focus({ preventScroll: true }); }
              else activate(item.id);
            });
            button.addEventListener("keydown", event => {
              const list = chrome.order, at = list.indexOf(item.id);
              const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : event.key === "ArrowRight" ? (at + 1) % list.length : event.key === "ArrowLeft" ? (at + list.length - 1) % list.length : -1;
              if (next < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
              event.preventDefault(); activate(list[next]!);
            });
            chrome.buttons.set(item.id, button);
          }
          button.textContent = item.title;
          button.setAttribute("aria-selected", String(item.id === selected && !this.collapsed(item.id)));
          if (this.native(item.id)) button.setAttribute("aria-controls", this.native(item.id)!.element.id);
          else if (this.slots.has(item.id)) button.setAttribute("aria-controls", `widget-view-${encodeURIComponent(item.id)}`);
          else button.removeAttribute("aria-controls");
          button.tabIndex = item.id === selected || (!selected && index === 0) ? 0 : -1;
          if (chrome.tabs.children[index] !== button) chrome.tabs.insertBefore(button, chrome.tabs.children[index] ?? null);
        }
      }
    } finally { this.rendering = false; }
  }
}
