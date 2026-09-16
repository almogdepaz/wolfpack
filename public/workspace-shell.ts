export const WORKSPACE_SHELL_PREFERENCE_KEY = "wolfpack-workspace-shell";
export type ContextPlacement = "right" | "left" | "bottom";
export type WorkspaceFullView = "none" | "context" | "terminals";

export interface WorkspaceShellPreferences {
  readonly placement: ContextPlacement;
  readonly splitSize: number;
  readonly contextCollapsed: boolean;
  readonly fullView: WorkspaceFullView;
}

export const DEFAULT_WORKSPACE_SHELL_PREFERENCES: WorkspaceShellPreferences = {
  placement: "right",
  splitSize: 320,
  contextCollapsed: false,
  fullView: "none",
};

function placement(value: unknown): ContextPlacement {
  return value === "left" || value === "bottom" || value === "right" ? value : DEFAULT_WORKSPACE_SHELL_PREFERENCES.placement;
}

export function normalizeWorkspaceShellPreferences(value: unknown): WorkspaceShellPreferences {
  const source = typeof value === "object" && value !== null ? value as Partial<WorkspaceShellPreferences> : {};
  const splitSize = typeof source.splitSize === "number" && Number.isFinite(source.splitSize)
    ? Math.round(source.splitSize) : DEFAULT_WORKSPACE_SHELL_PREFERENCES.splitSize;
  return {
    placement: placement(source.placement),
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
 * A host shell only: its context container is intentionally empty until phase 2
 * registers context views. Terminal containers remain in place underneath it.
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
  const placementControl = root.querySelector<HTMLSelectElement>("#workspace-context-placement");
  const splitControl = root.querySelector<HTMLInputElement>("#workspace-context-size");
  const collapseButton = root.querySelector<HTMLButtonElement>("#workspace-context-collapse");
  const contextFullButton = root.querySelector<HTMLButtonElement>("#workspace-context-full");
  const terminalFullButton = root.querySelector<HTMLButtonElement>("#workspace-terminal-full");
  const restoreButton = root.querySelector<HTMLButtonElement>("#workspace-restore");
  let geometryFrame: number | null = null;

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
    root.dataset.contextPlacement = current.placement;
    root.dataset.fullView = current.fullView;
    root.classList.toggle("workspace-context-collapsed", current.contextCollapsed);
    root.style.setProperty("--workspace-context-size", `${current.splitSize}px`);
    if (placementControl) placementControl.value = current.placement;
    if (splitControl) splitControl.value = String(current.splitSize);
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
    render(previous.placement !== current.placement || previous.splitSize !== current.splitSize || previous.contextCollapsed !== current.contextCollapsed || previous.fullView !== current.fullView);
  };
  const onPlacement = () => setPreferences({ placement: placement(placementControl?.value) });
  const onSplit = () => setPreferences({ splitSize: Number(splitControl?.value) });
  const onCollapse = () => setPreferences({ contextCollapsed: !current.contextCollapsed, fullView: current.fullView === "context" ? "none" : current.fullView });
  const onContextFull = () => setPreferences({ fullView: current.fullView === "context" ? "none" : "context" });
  const onTerminalFull = () => setPreferences({ fullView: current.fullView === "terminals" ? "none" : "terminals" });
  const onRestore = () => setPreferences({ fullView: "none", contextCollapsed: false });
  placementControl?.addEventListener("change", onPlacement);
  splitControl?.addEventListener("input", onSplit);
  collapseButton?.addEventListener("click", onCollapse);
  contextFullButton?.addEventListener("click", onContextFull);
  terminalFullButton?.addEventListener("click", onTerminalFull);
  restoreButton?.addEventListener("click", onRestore);
  render(false);

  return {
    get preferences() { return current; },
    get contextVisible() { return workspaceContextIsVisible(current); },
    setPreferences,
    dispose(): void {
      if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
      placementControl?.removeEventListener("change", onPlacement);
      splitControl?.removeEventListener("input", onSplit);
      collapseButton?.removeEventListener("click", onCollapse);
      contextFullButton?.removeEventListener("click", onContextFull);
      terminalFullButton?.removeEventListener("click", onTerminalFull);
      restoreButton?.removeEventListener("click", onRestore);
    },
  };
}
