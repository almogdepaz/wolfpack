import type { ContextViewRegistry, RegisteredContextView } from "./context-view-registry.ts";
import { WidgetLayout, WIDGET_AREAS, type WidgetArea, isWidgetArea, isNativePanel, TERMINALS_PANEL } from "./widget-layout.ts";

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
  readonly title: HTMLElement;
  readonly tabs: HTMLElement;
  readonly buttons: Map<string, HTMLButtonElement>;
  order: string[];
  readonly placement: HTMLSelectElement;
  readonly full: HTMLButtonElement;
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
  private rendering = false;
  private selecting = false;

  constructor(private readonly options: {
    readonly container: HTMLElement;
    readonly registry: ContextViewRegistry;
    readonly layout: WidgetLayout;
    readonly nativePanels?: readonly NativeWorkspacePanel[];
    readonly onAreasChange?: (areas: readonly WidgetArea[]) => void;
    readonly onFocus?: (area: WidgetArea | null) => void;
    readonly onGeometryChange?: () => void;
    readonly onSelect: (id: string) => void;
    readonly onMove: (id: string, area: WidgetArea) => void;
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
      ...(this.presentation.visible || includeHiddenWidgets ? this.entries.map(entry => ({ id: entry.id, title: entry.contribution.title })) : []),
    ];
  }
  private ids(): string[] { return this.panelEntries().map(entry => entry.id); }
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
    if (previous.desktop !== next.desktop) this.mobileSelection = null;
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
      const id = this.options.layout.selection(area, ids);
      if (id && id !== this.active[area]) this.select(id, false);
    }
  }
  move(id: string, area: WidgetArea): void {
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
    this.options.layout.reset();
    for (const area of WIDGET_AREAS) delete this.active[area];
    if (selected && this.slots.has(selected)) this.active.right = selected;
    this.render();
  }
  private activeIds(): string[] { return WIDGET_AREAS.flatMap(area => this.active[area] && this.mounted(this.active[area]!) ? [this.active[area]!] : []); }
  private occupiedAreas(): WidgetArea[] {
    const ids = this.ids();
    const areas = WIDGET_AREAS.filter(area => ids.some(id => this.area(id) === area));
    // A diagnostic placeholder remains useful when no extensions are available.
    if (!this.entries.length && this.presentation.visible && !areas.includes(this.options.layout.area(""))) areas.push(this.options.layout.area(""));
    return areas.length || !this.presentation.visible ? areas : [this.options.layout.area("")];
  }
  private visibleAreas(): readonly WidgetArea[] {
    const areas = this.occupiedAreas();
    return this.presentation.focusArea ? [areas.includes(this.presentation.focusArea) ? this.presentation.focusArea : areas[0]!] : areas;
  }
  private visibleIds(): string[] {
    if (!this.presentation.desktop) return this.presentation.visible && this.mobileSelection && this.slots.has(this.mobileSelection) ? [this.mobileSelection] : [];
    return this.visibleAreas().flatMap(area => this.active[area] && this.ids().includes(this.active[area]!) && this.mounted(this.active[area]!) ? [this.active[area]!] : []);
  }
  private createChrome(area: WidgetArea): Chrome {
    const label = area[0]!.toUpperCase() + area.slice(1);
    const placeholder = document.createElement("section");
    placeholder.className = "widget-panel"; placeholder.dataset.widgetArea = area;
    placeholder.setAttribute("role", "region"); placeholder.setAttribute("aria-label", `${label} widgets`);
    const node = document.createElement("div"); node.className = "widget-chrome";
    const header = document.createElement("header"); header.className = "workspace-context-header";
    const title = document.createElement("strong");
    const actions = document.createElement("div"); actions.className = "workspace-context-actions";
    const placement = document.createElement("select"); placement.dataset.widgetPlacement = ""; placement.setAttribute("aria-label", "Widget panel placement");
    for (const value of [...WIDGET_AREAS, "full-screen"]) {
      const option = document.createElement("option"); option.value = value; option.textContent = value === "full-screen" ? "Full screen" : value[0]!.toUpperCase() + value.slice(1); placement.append(option);
    }
    const full = document.createElement("button"); full.type = "button"; full.dataset.widgetFull = ""; full.className = "workspace-icon";
    full.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path class="expand-icon" d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><path class="restore-icon" d="M8 3v5H3m13-5v5h5M3 16h5v5m8 0v-5h5"/></svg>';
    placement.addEventListener("change", () => {
      const id = this.active[area];
      if (placement.value === "full-screen") this.options.onFocus?.(area);
      else if (isWidgetArea(placement.value)) {
        if (id) this.options.onMove(id, placement.value);
        else if (!this.entries.length) { this.options.layout.setDefaultArea(placement.value); this.options.onFocus?.(null); this.render(); }
      }
      this.chrome.get(this.area(id ?? ""))?.placement.focus({ preventScroll: true });
    });
    full.addEventListener("click", () => this.options.onFocus?.(this.presentation.focusArea ? null : area));
    actions.append(placement); actions.append(full); header.append(title); header.append(actions);
    const tabs = document.createElement("div"); tabs.dataset.extensionTabs = ""; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", `${label} widgets`);
    const status = document.createElement("p"); status.dataset.extensionStatus = ""; status.setAttribute("role", "status");
    const geometryStatus = document.createElement("p"); geometryStatus.dataset.workspaceLayoutStatus = ""; geometryStatus.setAttribute("role", "status"); geometryStatus.hidden = true;
    node.append(header); node.append(tabs); node.append(status); node.append(geometryStatus); placeholder.append(node);
    return { node, header, title, tabs, buttons: new Map(), order: [], placement, full, status, placeholder };
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
      const key = areas.join(",");
      if (key !== this.areasKey) { this.areasKey = key; this.options.onAreasChange?.(areas); }
      for (const [id, slot] of this.slots) slot.dataset.widgetArea = this.area(id);
      const visibleIds = this.visibleIds();
      this.options.registry.setVisibleIds(visibleIds.filter(id => !isNativePanel(id)));
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
        chrome.header.hidden = !!selected && isNativePanel(selected);
        chrome.title.textContent = entry?.title ?? "Widgets";
        chrome.placement.hidden = !this.presentation.desktop;
        chrome.placement.disabled = !entry && this.entries.length > 0;
        chrome.placement.value = this.presentation.focusArea ? "full-screen" : area;
        for (const child of Array.from(chrome.placement.children)) {
          const option = child as HTMLOptionElement;
          if (!isWidgetArea(option.value)) continue;
          const replacement = selected ? this.options.layout.replacement(selected, option.value, ids) : null;
          option.textContent = option.value[0]!.toUpperCase() + option.value.slice(1) + (replacement ? ` — ${this.panelEntries().find(panel => panel.id === replacement)?.title} moves to Main` : "");
          option.disabled = !!selected && ids.includes(TERMINALS_PANEL) && area === "main" && option.value !== "main" && !replacement && !ids.some(id => id !== selected && this.area(id) === "main");
        }
        chrome.full.hidden = !this.presentation.desktop;
        chrome.full.setAttribute("aria-label", chrome.full.title = this.presentation.focusArea ? "Restore workspace" : "Context full view");
        chrome.full.setAttribute("aria-pressed", String(!!this.presentation.focusArea));
        chrome.status.textContent = this.options.layout.diagnostic || (selected && isNativePanel(selected) ? "" : this.message || this.errors[area] || (selected ? this.documentStatus(selected) : entries.length ? "Select a context view." : "No enabled context views for this scope.")) || "";
        chrome.tabs.hidden = entries.length < 2 && (!entries.length || !!selected);
        chrome.tabs.setAttribute("aria-label", `${area[0]!.toUpperCase() + area.slice(1)} ${entries.some(entry => isNativePanel(entry.id)) ? "panels" : "widgets"}`);
        for (const [id, button] of chrome.buttons) if (!entries.some(entry => entry.id === id)) { button.remove(); chrome.buttons.delete(id); }
        chrome.order = entries.map(entry => entry.id);
        for (const [index, item] of entries.entries()) {
          let button = chrome.buttons.get(item.id);
          if (!button) {
            button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "tab");
            const activate = (id: string) => { this.options.onSelect(id); this.chrome.get(this.area(id))?.buttons.get(id)?.focus({ preventScroll: true }); };
            button.addEventListener("click", () => activate(item.id));
            button.addEventListener("keydown", event => {
              const list = chrome.order, at = list.indexOf(item.id);
              const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : event.key === "ArrowRight" ? (at + 1) % list.length : event.key === "ArrowLeft" ? (at + list.length - 1) % list.length : -1;
              if (next < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
              event.preventDefault(); activate(list[next]!);
            });
            chrome.buttons.set(item.id, button);
          }
          button.textContent = item.title;
          button.setAttribute("aria-selected", String(item.id === selected));
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
