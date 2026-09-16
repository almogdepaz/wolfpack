import {
  equalGridLayout,
  leadStackLayout,
  type LayoutContext,
  type TerminalLayout,
  type TerminalLayoutContribution,
  validateTerminalLayout,
  verticalStackLayout,
} from "../src/extensions/layout-contract";

export const BUILTIN_TERMINAL_LAYOUT_IDS = ["equal-grid", "lead-stack", "vertical-stack"] as const;
export type BuiltinTerminalLayoutId = typeof BUILTIN_TERMINAL_LAYOUT_IDS[number];
export const TERMINAL_LAYOUT_PREFERENCE_KEY = "wolfpack-terminal-layout";

export interface WorkspacePane {
  readonly id: string;
  readonly element: HTMLElement;
}

function isBuiltinLayoutId(value: string | null): value is BuiltinTerminalLayoutId {
  return value !== null && (BUILTIN_TERMINAL_LAYOUT_IDS as readonly string[]).includes(value);
}

/**
 * Host-owned registration seam. Contributions can only describe finite geometry;
 * this registry never receives terminal controllers, DOM ownership, or focus.
 */
export class TerminalLayoutRegistry {
  private readonly contributions = new Map<string, TerminalLayoutContribution>();
  private selected: BuiltinTerminalLayoutId;

  constructor(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    this.storage = storage;
    const stored = storage.getItem(TERMINAL_LAYOUT_PREFERENCE_KEY);
    this.selected = isBuiltinLayoutId(stored) ? stored : "equal-grid";
    this.registerBuiltin("equal-grid", "Equal grid", equalGridLayout);
    this.registerBuiltin("lead-stack", "Lead + stack", leadStackLayout);
    this.registerBuiltin("vertical-stack", "Vertical stack", verticalStackLayout);
  }

  private readonly storage: Pick<Storage, "getItem" | "setItem">;

  private registerBuiltin(id: BuiltinTerminalLayoutId, title: string, arrange: TerminalLayoutContribution["arrange"]): void {
    this.contributions.set(id, { id, title, arrange });
  }

  /** Reserved for phase-2 extension registration; duplicate IDs fail closed. */
  register(contribution: TerminalLayoutContribution): () => void {
    if (this.contributions.has(contribution.id)) throw new Error(`terminal layout already registered: ${contribution.id}`);
    this.contributions.set(contribution.id, contribution);
    return () => { if (this.contributions.get(contribution.id) === contribution) this.contributions.delete(contribution.id); };
  }

  get selectedId(): BuiltinTerminalLayoutId { return this.selected; }

  select(id: BuiltinTerminalLayoutId): void {
    if (!isBuiltinLayoutId(id)) return;
    this.selected = id;
    this.storage.setItem(TERMINAL_LAYOUT_PREFERENCE_KEY, id);
  }

  arrange(paneIds: readonly string[], selectedPaneId: string | null, viewport: Readonly<{ width: number; height: number }>): TerminalLayout {
    const context: LayoutContext = {
      panes: paneIds.map(id => ({ id })),
      selectedPaneId,
      viewport,
    };
    // Narrow/mobile recovery intentionally uses the host vertical layout; it
    // does not mutate the user's explicit desktop preference.
    const contribution = viewport.width <= 768
      ? this.contributions.get("vertical-stack")!
      : this.contributions.get(this.selected)!;
    try {
      return validateTerminalLayout(contribution.arrange(context), context.panes);
    } catch (error) {
      console.warn("[workspace] invalid terminal geometry; using equal grid", error);
      return equalGridLayout(context);
    }
  }
}

function trackList(tracks: readonly { readonly size: number }[]): string {
  return tracks.map(track => `minmax(0, ${track.size}fr)`).join(" ");
}

/** Apply geometry in stable existing cells only. It does not reorder or focus. */
export function clearTerminalLayoutGeometry(container: HTMLElement, panes: readonly WorkspacePane[]): void {
  container.style.gridTemplateRows = "";
  container.style.gridTemplateColumns = "";
  for (const pane of panes) {
    pane.element.style.gridRow = "";
    pane.element.style.gridColumn = "";
  }
}

export function applyTerminalLayoutGeometry(container: HTMLElement, panes: readonly WorkspacePane[], layout: TerminalLayout): boolean {
  if (container.clientWidth <= 0 || container.clientHeight <= 0) return false;
  const byId = new Map(panes.map(pane => [pane.id, pane.element]));
  container.style.gridTemplateRows = trackList(layout.rows);
  container.style.gridTemplateColumns = trackList(layout.columns);
  for (const placement of layout.placements) {
    const element = byId.get(placement.paneId);
    if (!element) continue;
    element.style.gridRow = `${placement.row + 1} / span ${placement.rowSpan ?? 1}`;
    element.style.gridColumn = `${placement.column + 1} / span ${placement.columnSpan ?? 1}`;
  }
  return true;
}

export function nearestPaneInDirection(layout: TerminalLayout, currentPaneId: string, direction: "left" | "right" | "up" | "down"): string | null {
  const current = layout.placements.find(placement => placement.paneId === currentPaneId);
  if (!current) return null;
  const center = (placement: typeof current) => ({
    x: placement.column + (placement.columnSpan ?? 1) / 2,
    y: placement.row + (placement.rowSpan ?? 1) / 2,
  });
  const from = center(current);
  const candidates = layout.placements
    .filter(placement => placement.paneId !== currentPaneId)
    .map(placement => ({ placement, point: center(placement) }))
    .filter(({ point }) => direction === "left" ? point.x < from.x : direction === "right" ? point.x > from.x : direction === "up" ? point.y < from.y : point.y > from.y)
    .sort((a, b) => {
      const aPrimary = direction === "left" || direction === "right" ? Math.abs(a.point.x - from.x) : Math.abs(a.point.y - from.y);
      const bPrimary = direction === "left" || direction === "right" ? Math.abs(b.point.x - from.x) : Math.abs(b.point.y - from.y);
      const aCross = direction === "left" || direction === "right" ? Math.abs(a.point.y - from.y) : Math.abs(a.point.x - from.x);
      const bCross = direction === "left" || direction === "right" ? Math.abs(b.point.y - from.y) : Math.abs(b.point.x - from.x);
      return aPrimary - bPrimary || aCross - bCross || a.placement.paneId.localeCompare(b.placement.paneId);
    });
  return candidates[0]?.placement.paneId ?? null;
}
