import { isWidgetArea, WIDGET_AREAS, type WidgetArea } from "./widget-layout.ts";
import type { WidgetPresentation } from "./widget-panels.ts";

export const WORKSPACE_SHELL_PREFERENCE_KEY = "wolfpack-workspace-shell";
export type WorkspaceFullView = "none" | "context" | "terminals";
export interface WorkspaceShellPreferences {
  readonly splitSize: number;
  readonly bottomSize: number;
  readonly panelPlacement: WidgetArea;
  readonly contextArea: WidgetArea;
  readonly contextCollapsed: boolean;
  readonly fullView: WorkspaceFullView;
}
export const DEFAULT_WORKSPACE_SHELL_PREFERENCES: WorkspaceShellPreferences = {
  splitSize: 320, bottomSize: 240, panelPlacement: "right", contextArea: "right", contextCollapsed: false, fullView: "none",
};
export function normalizeWorkspaceShellPreferences(value: unknown): WorkspaceShellPreferences {
  const source = typeof value === "object" && value !== null ? value as Partial<WorkspaceShellPreferences> : {};
  const size = (value: unknown, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback));
  return {
    splitSize: size(source.splitSize, 320, 220, 560), bottomSize: size(source.bottomSize, 240, 140, 480),
    // Preserve Step3 defaults; never revive the obsolete prototype `placement`.
    panelPlacement: source.panelPlacement === "bottom" ? "bottom" : "right",
    contextArea: isWidgetArea(source.contextArea) ? source.contextArea : source.panelPlacement === "bottom" ? "bottom" : "right",
    contextCollapsed: source.contextCollapsed === true,
    fullView: source.fullView === "context" || source.fullView === "terminals" ? source.fullView : "none",
  };
}
export function loadWorkspaceShellPreferences(storage: Pick<Storage, "getItem">): WorkspaceShellPreferences {
  try { return normalizeWorkspaceShellPreferences(JSON.parse(storage.getItem(WORKSPACE_SHELL_PREFERENCE_KEY) ?? "null")); }
  catch { return DEFAULT_WORKSPACE_SHELL_PREFERENCES; }
}
export function workspaceContextIsVisible(preferences: WorkspaceShellPreferences): boolean {
  return preferences.fullView === "context" || (preferences.fullView === "none" && !preferences.contextCollapsed);
}
/** Mobile opening is ephemeral and never rewrites the saved desktop layout. */
export function workspacePresentation(preferences: WorkspaceShellPreferences, desktop: boolean, mobileOpen: boolean): WorkspaceShellPreferences {
  return desktop ? preferences : { ...preferences, fullView: mobileOpen ? "context" : "none", contextCollapsed: !mobileOpen };
}
export interface WorkspaceShell {
  readonly preferences: WorkspaceShellPreferences;
  readonly contextVisible: boolean;
  readonly widgetPresentation: WidgetPresentation;
  setPreferences(next: Partial<WorkspaceShellPreferences>): void;
  setPanelAreas(areas: readonly WidgetArea[]): void;
  focusPanel(area: WidgetArea | null): void;
  closeMobileView(): void;
  dispose(): void;
}

/** Geometry only. Terminal and extension-owned nodes never reparent on layout changes. */
export function createWorkspaceShell(options: {
  readonly root?: HTMLElement | null;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly onTerminalGeometryChange?: () => void;
  readonly onContextVisibilityChange?: (visible: boolean) => void;
  readonly onWidgetPresentationChange?: (presentation: WidgetPresentation) => void;
  readonly onReset?: () => void;
} = {}): WorkspaceShell | null {
  const root = options.root ?? document.getElementById("workspace-shell");
  if (!root) return null;
  const storage = options.storage ?? localStorage;
  let current = loadWorkspaceShellPreferences(storage);
  let areas: readonly WidgetArea[] = [current.panelPlacement];
  const desktop = matchMedia("(min-width:769px)");
  let mobileOpen = false;
  const presentation = () => workspacePresentation(current, desktop.matches, mobileOpen);
  const widgetPresentation = (): WidgetPresentation => ({
    visible: workspaceContextIsVisible(presentation()), desktop: desktop.matches,
    focusArea: desktop.matches && current.fullView === "context" ? (areas.includes(current.contextArea) ? current.contextArea : areas[0]!) : null,
  });
  const dividers: Record<WidgetArea, HTMLElement | null> = {
    right: root.querySelector("#workspace-context-divider"), bottom: root.querySelector("#workspace-bottom-divider"),
  };
  const contextRegion = root.querySelector<HTMLElement>("#workspace-context-region");
  const collapseButton = document.querySelector<HTMLButtonElement>("#workspace-context-collapse");
  const restoreButton = document.querySelector<HTMLButtonElement>("#workspace-restore");
  const backButton = root.querySelector<HTMLButtonElement>("#workspace-context-back");
  const mobileHeader = root.querySelector<HTMLElement>("#workspace-mobile-header");
  const resetButton = document.getElementById("workspace-reset-layout");
  let drag: { id: number; area: WidgetArea; coordinate: number; size: number } | null = null;
  let geometryFrame: number | null = null;
  const events = new AbortController();
  const listen = (target: HTMLElement | null, type: string, handler: EventListener) => target?.addEventListener(type, handler, { signal: events.signal });
  const minimumSize = (area: WidgetArea) => Math.min(area === "bottom" ? 140 : 220, Math.max(0, Math.floor(((area === "bottom" ? root.clientHeight : root.clientWidth) - 6) / 2)));
  const maximumSize = (area: WidgetArea) => Math.max(minimumSize(area), area === "bottom" ? Math.min(480, root.clientHeight - 166) : Math.min(560, root.clientWidth - 246));
  const dimension = (area: WidgetArea) => Math.min(area === "bottom" ? current.bottomSize : current.splitSize, maximumSize(area));
  const finishResize = (event?: PointerEvent) => {
    if (event && drag && event.pointerId !== drag.id) return;
    const previous = drag; drag = null; root.classList.remove("workspace-resizing");
    if (previous && dividers[previous.area]?.hasPointerCapture(previous.id)) dividers[previous.area]!.releasePointerCapture(previous.id);
  };
  const persist = () => {
    let message = "";
    try { storage.setItem(WORKSPACE_SHELL_PREFERENCE_KEY, JSON.stringify(current)); }
    catch { message = "Layout changed for this tab only; browser storage is unavailable."; }
    for (const status of document.querySelectorAll<HTMLElement>("[data-workspace-layout-status]")) { status.textContent = message; status.hidden = !message; }
  };
  const notifyGeometry = () => {
    if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
    geometryFrame = null;
    if (presentation().fullView === "context") return;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = null;
      if (presentation().fullView !== "context" && root.clientWidth > 0 && root.clientHeight > 0) options.onTerminalGeometryChange?.();
    });
  };
  const render = (geometryChanged: boolean): void => {
    const effective = presentation();
    const visible = workspaceContextIsVisible(effective);
    root.dataset.fullView = effective.fullView;
    root.dataset.contextPlacement = areas.length === 1 ? areas[0]! : "both";
    root.classList.toggle("workspace-context-collapsed", !visible);
    for (const area of WIDGET_AREAS) {
      const enabled = desktop.matches && visible && effective.fullView === "none" && areas.includes(area);
      const size = dimension(area);
      root.style.setProperty(`--workspace-${area}-size`, `${enabled ? size : 0}px`);
      root.style.setProperty(`--workspace-${area}-divider`, enabled ? "6px" : "0px");
      const divider = dividers[area];
      if (divider) divider.hidden = !enabled;
      divider?.setAttribute("aria-valuemin", String(minimumSize(area)));
      divider?.setAttribute("aria-valuenow", String(size));
      divider?.setAttribute("aria-valuemax", String(maximumSize(area)));
    }
    if (!visible || effective.fullView !== "none" || !desktop.matches || (drag && !areas.includes(drag.area))) finishResize();
    if (collapseButton) { collapseButton.hidden = !visible; collapseButton.setAttribute("aria-expanded", String(visible)); }
    if (mobileHeader) mobileHeader.hidden = desktop.matches || !visible;
    if (backButton) backButton.hidden = desktop.matches;
    if (restoreButton) restoreButton.hidden = visible;
    options.onContextVisibilityChange?.(visible);
    options.onWidgetPresentationChange?.(widgetPresentation());
    if (geometryChanged) notifyGeometry();
  };
  const setPreferences = (next: Partial<WorkspaceShellPreferences>): void => {
    current = normalizeWorkspaceShellPreferences({ ...current, ...next }); persist(); render(true);
  };
  for (const area of WIDGET_AREAS) {
    const divider = dividers[area];
    const coordinate = (event: PointerEvent) => area === "bottom" ? event.clientY : event.clientX;
    const canResize = () => desktop.matches && !current.contextCollapsed && current.fullView === "none" && areas.includes(area);
    const resize = (size: number) => setPreferences(area === "bottom" ? { bottomSize: Math.min(size, maximumSize(area)) } : { splitSize: Math.min(size, maximumSize(area)) });
    const resizeEvents = {
      pointerdown: (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0 || !canResize()) return;
        event.preventDefault(); drag = { id: event.pointerId, area, coordinate: coordinate(event), size: dimension(area) };
        divider!.setPointerCapture(event.pointerId); root.style.setProperty("--workspace-resize-cursor", area === "bottom" ? "row-resize" : "col-resize"); root.classList.add("workspace-resizing");
      },
      pointermove: (event: PointerEvent) => { if (drag?.area === area && drag.id === event.pointerId) resize(drag.size + drag.coordinate - coordinate(event)); },
      pointerup: finishResize, pointercancel: finishResize, lostpointercapture: finishResize,
      keydown: (event: KeyboardEvent) => {
        if (!canResize() || event.altKey || event.ctrlKey || event.metaKey) return;
        const size = dimension(area);
        const sizes: Partial<Record<string, number>> = { [area === "bottom" ? "ArrowUp" : "ArrowLeft"]: size + 10, [area === "bottom" ? "ArrowDown" : "ArrowRight"]: size - 10, Home: minimumSize(area), End: maximumSize(area) };
        if (sizes[event.key] === undefined) return;
        event.preventDefault(); resize(sizes[event.key]!);
      },
    };
    for (const [type, handler] of Object.entries(resizeEvents)) listen(divider, type, handler as EventListener);
  }
  const observer = new ResizeObserver(() => render(true)); observer.observe(root);
  const onBreakpoint = () => {
    const panelHadFocus = contextRegion?.contains(document.activeElement);
    finishResize(); mobileOpen = false; render(true);
    if (panelHadFocus) (workspaceContextIsVisible(presentation()) ? collapseButton : restoreButton)?.focus({ preventScroll: true });
  };
  desktop.addEventListener("change", onBreakpoint);
  const close = () => {
    if (desktop.matches) setPreferences({ contextCollapsed: true, fullView: "none" }); else { mobileOpen = false; render(true); }
    restoreButton?.focus({ preventScroll: true });
  };
  listen(collapseButton, "click", close); listen(backButton, "click", close);
  listen(restoreButton, "click", () => {
    if (desktop.matches) setPreferences({ fullView: "none", contextCollapsed: false }); else { mobileOpen = true; render(true); }
    (desktop.matches ? collapseButton : backButton)?.focus({ preventScroll: true });
  });
  listen(resetButton, "click", () => { mobileOpen = false; setPreferences(DEFAULT_WORKSPACE_SHELL_PREFERENCES); options.onReset?.(); });
  render(false);
  return {
    get preferences() { return current; }, get contextVisible() { return workspaceContextIsVisible(presentation()); }, get widgetPresentation() { return widgetPresentation(); },
    setPreferences,
    setPanelAreas(next): void {
      const valid = WIDGET_AREAS.filter(area => next.includes(area));
      const normalized = valid.length ? valid : [current.panelPlacement];
      if (areas.join() === normalized.join()) return;
      areas = normalized; render(true);
    },
    focusPanel(area): void {
      if (!desktop.matches) return;
      setPreferences({ fullView: area ? "context" : "none", ...(area ? { contextArea: area, contextCollapsed: false } : {}) });
      if (!workspaceContextIsVisible(presentation())) restoreButton?.focus({ preventScroll: true });
    },
    closeMobileView(): void { if (mobileOpen) { mobileOpen = false; render(true); } },
    dispose(): void {
      finishResize(); observer.disconnect(); desktop.removeEventListener("change", onBreakpoint);
      if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
      events.abort();
    },
  };
}
