export const WORKSPACE_SHELL_PREFERENCE_KEY = "wolfpack-workspace-shell";
export type WorkspaceFullView = "none" | "context" | "terminals";

export interface WorkspaceShellPreferences {
  readonly splitSize: number;
  readonly bottomSize: number;
  readonly panelPlacement: "right" | "bottom";
  readonly contextCollapsed: boolean;
  readonly fullView: WorkspaceFullView;
}

export const DEFAULT_WORKSPACE_SHELL_PREFERENCES: WorkspaceShellPreferences = {
  splitSize: 320, bottomSize: 240, panelPlacement: "right", contextCollapsed: false, fullView: "none",
};

export function normalizeWorkspaceShellPreferences(value: unknown): WorkspaceShellPreferences {
  const source = typeof value === "object" && value !== null ? value as Partial<WorkspaceShellPreferences> : {};
  const size = (value: unknown, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback));
  return {
    splitSize: size(source.splitSize, 320, 220, 560),
    bottomSize: size(source.bottomSize, 240, 140, 480),
    // Do not revive the obsolete `placement` preference from the prototype shell.
    panelPlacement: source.panelPlacement === "bottom" ? "bottom" : "right",
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
  setPreferences(next: Partial<WorkspaceShellPreferences>): void;
  closeMobileView(): void;
  dispose(): void;
}

/** Host-owned geometry: placement/resizing never reparents terminal or extension containers. */
export function createWorkspaceShell(options: {
  readonly root?: HTMLElement | null;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly onTerminalGeometryChange?: () => void;
  readonly onContextVisibilityChange?: (visible: boolean) => void;
} = {}): WorkspaceShell | null {
  const root = options.root ?? document.getElementById("workspace-shell");
  if (!root) return null;
  const storage = options.storage ?? localStorage;
  let current = loadWorkspaceShellPreferences(storage);
  const desktop = matchMedia("(min-width:769px)");
  let mobileOpen = false;
  const presentation = () => workspacePresentation(current, desktop.matches, mobileOpen);
  const divider = root.querySelector<HTMLElement>("#workspace-context-divider");
  const contextRegion = root.querySelector<HTMLElement>("#workspace-context-region");
  const collapseButton = document.querySelector<HTMLButtonElement>("#workspace-context-collapse");
  const contextFullButton = root.querySelector<HTMLButtonElement>("#workspace-context-full");
  const restoreButton = document.querySelector<HTMLButtonElement>("#workspace-restore");
  const backButton = root.querySelector<HTMLButtonElement>("#workspace-context-back");
  const placement = root.querySelector<HTMLSelectElement>("#workspace-panel-placement");
  const resetButton = document.getElementById("workspace-reset-layout");
  const statuses = document.querySelectorAll<HTMLElement>("[data-workspace-layout-status]");
  let drag: { id: number; coordinate: number; size: number } | null = null;
  let geometryFrame: number | null = null;
  const events = new AbortController();
  const listen = (target: HTMLElement | null, type: string, handler: EventListener) => target?.addEventListener(type, handler, { signal: events.signal });
  const bottom = () => current.panelPlacement === "bottom";
  // On a very short desktop, share the remaining height rather than squeezing
  // the terminal to zero. Keep the persisted preferred height unchanged.
  const minimumSize = () => bottom() ? Math.min(140, Math.max(0, Math.floor((root.clientHeight - 6) / 2))) : 220;
  const maximumSize = () => Math.max(minimumSize(), bottom() ? Math.min(480, root.clientHeight - 166) : Math.min(560, root.clientWidth - 246));
  const finishResize = (event?: PointerEvent) => {
    if (event && drag && event.pointerId !== drag.id) return;
    const id = drag?.id;
    drag = null;
    root.classList.remove("workspace-resizing");
    if (id !== undefined && divider?.hasPointerCapture(id)) divider.releasePointerCapture(id);
  };
  const persist = () => {
    let message = "";
    try { storage.setItem(WORKSPACE_SHELL_PREFERENCE_KEY, JSON.stringify(current)); }
    catch { message = "Layout changed for this tab only; browser storage is unavailable."; }
    for (const status of statuses) { status.textContent = message; status.hidden = !message; }
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
    root.dataset.fullView = effective.fullView;
    root.dataset.contextPlacement = current.panelPlacement;
    root.classList.toggle("workspace-context-collapsed", effective.contextCollapsed);
    const size = Math.min(bottom() ? current.bottomSize : current.splitSize, maximumSize());
    root.style.setProperty("--workspace-context-size", `${size}px`);
    divider?.setAttribute("aria-orientation", bottom() ? "horizontal" : "vertical");
    divider?.setAttribute("aria-valuemin", String(minimumSize()));
    divider?.setAttribute("aria-valuenow", String(size));
    divider?.setAttribute("aria-valuemax", String(maximumSize()));
    if (effective.contextCollapsed || effective.fullView !== "none" || !desktop.matches) finishResize();
    const visible = workspaceContextIsVisible(effective);
    if (collapseButton) { collapseButton.hidden = !visible; collapseButton.setAttribute("aria-expanded", String(visible)); }
    if (contextFullButton) {
      contextFullButton.hidden = !desktop.matches;
      contextFullButton.setAttribute("aria-pressed", String(effective.fullView === "context"));
      contextFullButton.setAttribute("aria-label", contextFullButton.title = effective.fullView === "context" ? "Restore workspace" : "Context full view");
    }
    if (placement) { placement.hidden = !desktop.matches; placement.value = current.fullView === "context" ? "full-screen" : current.panelPlacement; }
    if (backButton) backButton.hidden = desktop.matches;
    if (restoreButton) restoreButton.hidden = visible;
    options.onContextVisibilityChange?.(visible);
    if (geometryChanged) notifyGeometry();
  };
  const setPreferences = (next: Partial<WorkspaceShellPreferences>): void => {
    if (next.panelPlacement !== undefined && next.panelPlacement !== current.panelPlacement) finishResize();
    current = normalizeWorkspaceShellPreferences({ ...current, ...next });
    persist();
    render(true);
  };
  const resize = (size: number) => setPreferences(bottom() ? { bottomSize: Math.min(size, maximumSize()) } : { splitSize: Math.min(size, maximumSize()) });
  const canResize = () => desktop.matches && !current.contextCollapsed && current.fullView === "none";
  const dimension = () => bottom() ? contextRegion!.getBoundingClientRect().height : contextRegion!.getBoundingClientRect().width;
  const coordinate = (event: PointerEvent) => bottom() ? event.clientY : event.clientX;
  const resizeEvents = {
    pointerdown: (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || !canResize()) return;
      event.preventDefault();
      drag = { id: event.pointerId, coordinate: coordinate(event), size: dimension() };
      divider!.setPointerCapture(event.pointerId);
      root.classList.add("workspace-resizing");
    },
    pointermove: (event: PointerEvent) => { if (drag?.id === event.pointerId) resize(drag.size + drag.coordinate - coordinate(event)); },
    pointerup: finishResize, pointercancel: finishResize, lostpointercapture: finishResize,
    keydown: (event: KeyboardEvent) => {
      if (!canResize() || event.altKey || event.ctrlKey || event.metaKey) return;
      const size = dimension();
      const sizes: Partial<Record<string, number>> = { [bottom() ? "ArrowUp" : "ArrowLeft"]: size + 10, [bottom() ? "ArrowDown" : "ArrowRight"]: size - 10, Home: minimumSize(), End: maximumSize() };
      const next = sizes[event.key];
      if (next === undefined) return;
      event.preventDefault();
      resize(next);
    },
  };
  for (const [type, handler] of Object.entries(resizeEvents)) listen(divider, type, handler as EventListener);
  const observer = new ResizeObserver(() => render(true));
  observer.observe(root);
  const onBreakpoint = () => {
    const panelHadFocus = contextRegion?.contains(document.activeElement);
    finishResize(); mobileOpen = false; render(true);
    if (panelHadFocus) (workspaceContextIsVisible(presentation()) ? contextFullButton : restoreButton)?.focus({ preventScroll: true });
  };
  desktop.addEventListener("change", onBreakpoint);
  const close = () => {
    if (desktop.matches) setPreferences({ contextCollapsed: true, fullView: "none" });
    else { mobileOpen = false; render(true); }
    restoreButton?.focus({ preventScroll: true });
  };
  listen(collapseButton, "click", close);
  listen(backButton, "click", close);
  listen(contextFullButton, "click", () => {
    setPreferences({ fullView: current.fullView === "context" ? "none" : "context" });
    if (!workspaceContextIsVisible(presentation())) restoreButton?.focus({ preventScroll: true });
  });
  listen(restoreButton, "click", () => {
    if (desktop.matches) setPreferences({ fullView: "none", contextCollapsed: false });
    else { mobileOpen = true; render(true); }
    (desktop.matches ? collapseButton : backButton)?.focus({ preventScroll: true });
  });
  listen(placement, "change", () => {
    if (!desktop.matches) return;
    const value = placement!.value;
    if (value === "full-screen") setPreferences({ fullView: "context", contextCollapsed: false });
    else if (value === "right" || value === "bottom") setPreferences({ panelPlacement: value, fullView: "none", contextCollapsed: false });
  });
  listen(resetButton, "click", () => { mobileOpen = false; setPreferences(DEFAULT_WORKSPACE_SHELL_PREFERENCES); });
  render(false);
  return {
    get preferences() { return current; },
    get contextVisible() { return workspaceContextIsVisible(presentation()); },
    setPreferences,
    closeMobileView(): void { if (mobileOpen) { mobileOpen = false; render(true); } },
    dispose(): void {
      finishResize(); observer.disconnect(); desktop.removeEventListener("change", onBreakpoint);
      if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
      events.abort();
    },
  };
}
