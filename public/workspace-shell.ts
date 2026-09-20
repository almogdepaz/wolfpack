export const WORKSPACE_SHELL_PREFERENCE_KEY = "wolfpack-workspace-shell";
export type WorkspaceFullView = "none" | "context" | "terminals";

export interface WorkspaceShellPreferences {
  readonly splitSize: number;
  readonly contextCollapsed: boolean;
  readonly fullView: WorkspaceFullView;
}

export const DEFAULT_WORKSPACE_SHELL_PREFERENCES: WorkspaceShellPreferences = {
  splitSize: 320,
  contextCollapsed: false,
  fullView: "none",
};

export function normalizeWorkspaceShellPreferences(value: unknown): WorkspaceShellPreferences {
  const source = typeof value === "object" && value !== null ? value as Partial<WorkspaceShellPreferences> : {};
  const splitSize = typeof source.splitSize === "number" && Number.isFinite(source.splitSize)
    ? Math.round(source.splitSize) : DEFAULT_WORKSPACE_SHELL_PREFERENCES.splitSize;
  return {
    splitSize: Math.max(220, Math.min(560, splitSize)),
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

export interface WorkspaceShell {
  readonly preferences: WorkspaceShellPreferences;
  readonly contextVisible: boolean;
  setPreferences(next: Partial<WorkspaceShellPreferences>): void;
  dispose(): void;
}

/**
 * Host-owned geometry: resizing never reparents or replaces terminal containers.
 */
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
  const divider = root.querySelector<HTMLElement>("#workspace-context-divider");
  const contextRegion = root.querySelector<HTMLElement>("#workspace-context-region");
  let drag: { id: number; x: number; size: number } | null = null;
  const maximumSize = () => Math.max(220, Math.min(560, root.clientWidth - 246));
  const finishResize = (event?: PointerEvent) => {
    if (event && drag && event.pointerId !== drag.id) return;
    const id = drag?.id;
    drag = null;
    root.classList.remove("workspace-resizing");
    if (id !== undefined && divider?.hasPointerCapture(id)) divider.releasePointerCapture(id);
  };
  const collapseButton = root.querySelector<HTMLButtonElement>("#workspace-context-collapse");
  const contextFullButton = root.querySelector<HTMLButtonElement>("#workspace-context-full");
  const terminalFullButton = root.querySelector<HTMLButtonElement>("#workspace-terminal-full");
  const restoreButton = root.querySelector<HTMLButtonElement>("#workspace-restore");
  let geometryFrame: number | null = null;
  const events = new AbortController();
  const listen = (target: HTMLElement | null, type: string, handler: EventListener) => target?.addEventListener(type, handler, { signal: events.signal });

  const persist = () => storage.setItem(WORKSPACE_SHELL_PREFERENCE_KEY, JSON.stringify(current));
  const notifyGeometry = () => {
    if (current.fullView === "context") return; // never resize a hidden terminal to zero geometry
    if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = null;
      options.onTerminalGeometryChange?.();
    });
  };
  const render = (geometryChanged: boolean): void => {
    root.dataset.fullView = current.fullView;
    root.classList.toggle("workspace-context-collapsed", current.contextCollapsed);
    const size = Math.min(current.splitSize, maximumSize());
    root.style.setProperty("--workspace-context-size", `${size}px`);
    divider?.setAttribute("aria-valuenow", String(size));
    divider?.setAttribute("aria-valuemax", String(maximumSize()));
    if (current.contextCollapsed || current.fullView !== "none") finishResize();
    if (collapseButton) collapseButton.setAttribute("aria-expanded", String(!current.contextCollapsed));
    if (contextFullButton) contextFullButton.setAttribute("aria-pressed", String(current.fullView === "context"));
    if (terminalFullButton) terminalFullButton.setAttribute("aria-pressed", String(current.fullView === "terminals"));
    if (restoreButton) restoreButton.hidden = current.fullView === "none" && !current.contextCollapsed;
    options.onContextVisibilityChange?.(workspaceContextIsVisible(current));
    if (geometryChanged) notifyGeometry();
  };
  const setPreferences = (next: Partial<WorkspaceShellPreferences>): void => {
    const previous = current;
    current = normalizeWorkspaceShellPreferences({ ...current, ...next });
    persist();
    render(previous.splitSize !== current.splitSize || previous.contextCollapsed !== current.contextCollapsed || previous.fullView !== current.fullView);
  };
  const resize = (size: number) => setPreferences({ splitSize: Math.min(size, maximumSize()) });
  const resizeEvents = {
    pointerdown: (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || current.contextCollapsed || current.fullView !== "none") return;
      event.preventDefault(); // keep the terminal/editor focus while dragging its border
      drag = { id: event.pointerId, x: event.clientX, size: contextRegion!.getBoundingClientRect().width };
      divider!.setPointerCapture(event.pointerId);
      root.classList.add("workspace-resizing");
    },
    pointermove: (event: PointerEvent) => {
      if (drag?.id === event.pointerId) resize(drag.size + drag.x - event.clientX);
    },
    pointerup: finishResize,
    pointercancel: finishResize,
    lostpointercapture: finishResize,
    keydown: (event: KeyboardEvent) => {
      const size = contextRegion!.getBoundingClientRect().width;
      const sizes: Partial<Record<string, number>> = { ArrowLeft: size + 10, ArrowRight: size - 10, Home: 220, End: maximumSize() };
      const next = sizes[event.key];
      if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      resize(next);
    },
  };
  for (const [type, handler] of Object.entries(resizeEvents)) listen(divider, type, handler as EventListener);
  const observer = new ResizeObserver(() => render(true));
  observer.observe(root);
  listen(collapseButton, "click", () => setPreferences({ contextCollapsed: !current.contextCollapsed, fullView: current.fullView === "context" ? "none" : current.fullView }));
  listen(contextFullButton, "click", () => setPreferences({ fullView: current.fullView === "context" ? "none" : "context" }));
  listen(terminalFullButton, "click", () => setPreferences({ fullView: current.fullView === "terminals" ? "none" : "terminals" }));
  listen(restoreButton, "click", () => setPreferences({ fullView: "none", contextCollapsed: false }));
  render(false);

  return {
    get preferences() { return current; },
    get contextVisible() { return workspaceContextIsVisible(current); },
    setPreferences,
    dispose(): void {
      finishResize();
      observer.disconnect();
      if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
      events.abort();
    },
  };
}
