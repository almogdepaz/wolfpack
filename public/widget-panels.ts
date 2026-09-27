import type { ContextViewRegistry, RegisteredContextView } from "./context-view-registry.ts";
import { WidgetLayout, WIDGET_AREAS, type WidgetArea, isWidgetArea } from "./widget-layout.ts";

export interface WidgetPresentation {
  readonly visible: boolean;
  readonly desktop: boolean;
  readonly focusArea: WidgetArea | null;
}
interface Chrome {
  readonly node: HTMLElement;
  readonly title: HTMLElement;
  readonly tabs: HTMLElement;
  readonly buttons: Map<string, HTMLButtonElement>;
  order: string[];
  readonly placement: HTMLSelectElement;
  readonly full: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly placeholder: HTMLElement;
}

/** Two bounded areas share one registry. Only host chrome moves; view roots never do. */
export class WidgetPanels {
  private entries: readonly RegisteredContextView[] = [];
  private readonly slots = new Map<string, HTMLElement>();
  private readonly chrome = new Map<WidgetArea, Chrome>();
  private readonly active: Partial<Record<WidgetArea, string>> = {};
  private readonly errors: Partial<Record<WidgetArea, string>> = {};
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
    readonly onAreasChange?: (areas: readonly WidgetArea[]) => void;
    readonly onFocus?: (area: WidgetArea | null) => void;
    readonly onSelect: (id: string) => void;
  }) {
    for (const area of WIDGET_AREAS) this.chrome.set(area, this.createChrome(area));
  }
  get selectedId(): string | null {
    if (!this.presentation.desktop && this.mobileSelection && this.slots.has(this.mobileSelection)) return this.mobileSelection;
    const ids = this.activeIds();
    return this.lastSelected && ids.includes(this.lastSelected) ? this.lastSelected : ids[0] ?? null;
  }
  createContainer(entry: RegisteredContextView, wrapper: HTMLElement, signal: AbortSignal): HTMLElement {
    wrapper.className = "widget-panel";
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `${entry.contribution.title} widget`);
    wrapper.dataset.widgetArea = this.options.layout.area(entry.id);
    const body = document.createElement("div");
    body.className = "widget-content";
    const content = document.createElement("div");
    delete wrapper.dataset.contextView;
    content.dataset.contextView = entry.id;
    content.id = `widget-view-${encodeURIComponent(entry.id)}`;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-label", entry.contribution.title);
    body.append(content);
    wrapper.append(body);
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
    this.entries = entries;
    this.message = message;
    this.documentStatus = documentStatus;
    for (const area of WIDGET_AREAS) if (!entries.some(entry => entry.id === this.active[area] && this.options.layout.area(entry.id) === area)) delete this.active[area];
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
    if (!this.entries.some(entry => entry.id === id)) { this.options.registry.select(id); return; }
    const area = this.options.layout.area(id);
    // A failing mount must not briefly hide/pause the previously selected tab.
    // Registry callbacks can update status synchronously; commit chrome only once
    // the registry has either accepted the new controller or retained the old one.
    this.selecting = true;
    try {
      const keep = this.presentation.desktop ? this.visibleIds().filter(other => this.options.layout.area(other) !== area) : [];
      this.options.registry.select(id, keep);
    } finally { this.selecting = false; }
    if (this.options.registry.selectedId !== id) {
      this.errors[area] = this.options.registry.diagnostic;
    } else {
      if (this.presentation.desktop) this.active[area] = id; else this.mobileSelection = id;
      this.lastSelected = id;
      delete this.errors[area];
      if (persist && this.presentation.desktop) this.options.layout.select(id);
    }
    this.render();
  }
  /** Caller owns complete-catalog and visible-shell gates. */
  selectDefaults(): void {
    if (!this.presentation.visible) return;
    const ids = this.entries.map(entry => entry.id);
    if (!this.presentation.desktop) {
      const id = this.mobileSelection ?? this.selectedId ?? (ids.length === 1 ? ids[0]! : null);
      if (id && !this.mobileSelection) this.select(id, false);
      return;
    }
    for (const area of this.visibleAreas()) {
      if (this.active[area] && this.slots.has(this.active[area]!)) continue;
      const id = this.options.layout.selection(area, ids);
      if (id) this.select(id, false);
    }
  }
  move(id: string, area: WidgetArea): void {
    if (!this.presentation.desktop || !this.slots.has(id) || !this.entries.some(entry => entry.id === id)) return;
    const from = this.options.layout.area(id);
    this.options.layout.move(id, area);
    if (this.active[from] === id) delete this.active[from];
    this.active[area] = id;
    this.options.onFocus?.(null);
    if (from !== area) {
      const remaining = this.entries.filter(entry => entry.id !== id && this.options.layout.area(entry.id) === from);
      const replacement = remaining.find(entry => this.slots.has(entry.id)) ?? (remaining.length === 1 ? remaining[0] : undefined);
      if (replacement) this.select(replacement.id);
    }
    this.lastSelected = id;
    this.render();
  }
  reset(): void {
    const selected = this.selectedId;
    this.options.layout.reset();
    delete this.active.bottom;
    delete this.active.right;
    if (selected && this.slots.has(selected)) this.active.right = selected;
    this.render();
  }
  private activeIds(): string[] {
    return WIDGET_AREAS.flatMap(area => this.active[area] && this.slots.has(this.active[area]!) ? [this.active[area]!] : []);
  }
  private occupiedAreas(): WidgetArea[] {
    const areas = WIDGET_AREAS.filter(area => this.entries.some(entry => this.options.layout.area(entry.id) === area));
    return areas.length ? areas : [this.options.layout.area("")];
  }
  private visibleAreas(): readonly WidgetArea[] {
    const areas = this.occupiedAreas();
    return this.presentation.focusArea ? [areas.includes(this.presentation.focusArea) ? this.presentation.focusArea : areas[0]!] : areas;
  }
  private visibleIds(): string[] {
    if (!this.presentation.visible) return [];
    if (!this.presentation.desktop) return this.mobileSelection && this.slots.has(this.mobileSelection) ? [this.mobileSelection] : [];
    return this.visibleAreas().flatMap(area => this.active[area] && this.slots.has(this.active[area]!) ? [this.active[area]!] : []);
  }
  private createChrome(area: WidgetArea): Chrome {
    const placeholder = document.createElement("section");
    placeholder.className = "widget-panel";
    placeholder.dataset.widgetArea = area;
    placeholder.setAttribute("role", "region");
    placeholder.setAttribute("aria-label", `${area === "right" ? "Right" : "Bottom"} widgets`);
    const node = document.createElement("div");
    node.className = "widget-chrome";
    const header = document.createElement("header");
    header.className = "workspace-context-header";
    const title = document.createElement("strong");
    const actions = document.createElement("div");
    actions.className = "workspace-context-actions";
    const placement = document.createElement("select");
    placement.dataset.widgetPlacement = "";
    placement.setAttribute("aria-label", "Widget panel placement");
    for (const [value, label] of [["right", "Right"], ["bottom", "Bottom"], ["full-screen", "Full screen"]]) {
      const option = document.createElement("option"); option.value = value!; option.textContent = label!; placement.append(option);
    }
    const full = document.createElement("button");
    full.type = "button"; full.dataset.widgetFull = ""; full.className = "workspace-icon";
    full.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path class="expand-icon" d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><path class="restore-icon" d="M8 3v5H3m13-5v5h5M3 16h5v5m8 0v-5h5"/></svg>';
    placement.addEventListener("change", () => {
      const id = this.active[area];
      if (placement.value === "full-screen") this.options.onFocus?.(area);
      else if (isWidgetArea(placement.value)) {
        if (id) this.move(id, placement.value);
        else if (!this.entries.length) { this.options.layout.setDefaultArea(placement.value); this.options.onFocus?.(null); this.render(); }
      }
      this.chrome.get(this.options.layout.area(id ?? ""))?.placement.focus({ preventScroll: true });
    });
    full.addEventListener("click", () => this.options.onFocus?.(this.presentation.focusArea ? null : area));
    actions.append(placement); actions.append(full); header.append(title); header.append(actions);
    const tabs = document.createElement("div");
    tabs.dataset.extensionTabs = ""; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", `${area === "right" ? "Right" : "Bottom"} widgets`);
    const status = document.createElement("p"); status.dataset.extensionStatus = ""; status.setAttribute("role", "status");
    const geometryStatus = document.createElement("p"); geometryStatus.dataset.workspaceLayoutStatus = ""; geometryStatus.setAttribute("role", "status"); geometryStatus.hidden = true;
    node.append(header); node.append(tabs); node.append(status); node.append(geometryStatus); placeholder.append(node);
    return { node, title, tabs, buttons: new Map(), order: [], placement, full, status, placeholder };
  }
  private render(): void {
    if (this.rendering || this.selecting) return;
    this.rendering = true;
    try {
      const areas = this.occupiedAreas();
      const key = areas.join(",");
      if (key !== this.areasKey) { this.areasKey = key; this.options.onAreasChange?.(areas); }
      for (const [id, slot] of this.slots) slot.dataset.widgetArea = this.options.layout.area(id);
      const visibleIds = this.visibleIds();
      this.options.registry.setVisibleIds(visibleIds);
      const mobileArea = this.mobileSelection ? this.options.layout.area(this.mobileSelection) : areas[0]!;
      for (const area of WIDGET_AREAS) {
        const chrome = this.chrome.get(area)!;
        if (areas.includes(area)) {
          if (!chrome.placeholder.parentElement) this.options.container.append(chrome.placeholder);
        } else chrome.placeholder.remove();
        const selected = this.presentation.desktop ? this.active[area] : area === mobileArea ? this.mobileSelection : null;
        const target = selected ? this.slots.get(selected) ?? chrome.placeholder : chrome.placeholder;
        const focus = document.activeElement as HTMLElement | null;
        const hadFocus = focus && chrome.node.contains(focus);
        if (chrome.node.parentElement !== target) {
          target.prepend(chrome.node);
          if (hadFocus) focus.focus({ preventScroll: true });
        }
        chrome.placeholder.hidden = target !== chrome.placeholder || !this.presentation.visible || (this.presentation.desktop ? !this.visibleAreas().includes(area) : area !== mobileArea);
        const entries = this.presentation.desktop ? this.entries.filter(entry => this.options.layout.area(entry.id) === area) : area === mobileArea ? this.entries : [];
        const entry = entries.find(entry => entry.id === selected);
        chrome.title.textContent = entry?.contribution.title ?? "Widgets";
        chrome.placement.hidden = !this.presentation.desktop;
        chrome.placement.disabled = !entry && this.entries.length > 0;
        chrome.placement.value = this.presentation.focusArea ? "full-screen" : area;
        chrome.full.hidden = !this.presentation.desktop;
        chrome.full.setAttribute("aria-label", chrome.full.title = this.presentation.focusArea ? "Restore workspace" : "Context full view");
        chrome.full.setAttribute("aria-pressed", String(!!this.presentation.focusArea));
        chrome.status.textContent = this.options.layout.diagnostic || this.message || this.errors[area] || (selected ? this.documentStatus(selected) : entries.length ? "Select a context view." : "No enabled context views for this scope.") || "";
        chrome.tabs.hidden = entries.length < 2 && (!entries.length || !!selected);
        for (const [id, button] of chrome.buttons) if (!entries.some(entry => entry.id === id)) { button.remove(); chrome.buttons.delete(id); }
        chrome.order = entries.map(entry => entry.id);
        for (const [index, item] of entries.entries()) {
          let button = chrome.buttons.get(item.id);
          if (!button) {
            button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "tab");
            const activate = (id: string) => {
              this.options.onSelect(id);
              this.chrome.get(this.options.layout.area(id))?.buttons.get(id)?.focus({ preventScroll: true });
            };
            button.addEventListener("click", () => activate(item.id));
            button.addEventListener("keydown", event => {
              const list = chrome.order; const at = list.indexOf(item.id);
              const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : event.key === "ArrowRight" ? (at + 1) % list.length : event.key === "ArrowLeft" ? (at + list.length - 1) % list.length : -1;
              if (next < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
              event.preventDefault(); activate(list[next]!);
            });
            chrome.buttons.set(item.id, button);
          }
          button.textContent = item.contribution.title;
          button.setAttribute("aria-selected", String(item.id === selected));
          if (this.slots.has(item.id)) button.setAttribute("aria-controls", `widget-view-${encodeURIComponent(item.id)}`);
          else button.removeAttribute("aria-controls");
          button.tabIndex = item.id === selected || (!selected && index === 0) ? 0 : -1;
          if (chrome.tabs.children[index] !== button) chrome.tabs.insertBefore(button, chrome.tabs.children[index] ?? null);
        }
      }
    } finally { this.rendering = false; }
  }
}
