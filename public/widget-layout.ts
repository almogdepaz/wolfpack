import { isExtensionIdentifier } from "../src/extensions/contribution-metadata.ts";

export type WidgetArea = "left" | "main" | "right" | "bottom";
export const WIDGET_AREAS: readonly WidgetArea[] = ["left", "main", "right", "bottom"];
// These IDs cannot collide with qualified extension contribution IDs.
export const SESSIONS_PANEL = ":sessions";
export const TERMINALS_PANEL = ":terminals";
export function isNativePanel(id: string): boolean { return id === SESSIONS_PANEL || id === TERMINALS_PANEL; }
export const WIDGET_LAYOUT_KEY = "wolfpack-widget-layout:v1";
const MAX_PLACEMENTS = 128;
export interface WidgetLayoutPreferences {
  readonly defaultArea?: WidgetArea;
  readonly placements: Readonly<Record<string, WidgetArea>>;
  readonly selected: Readonly<Partial<Record<WidgetArea, string>>>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function isWidgetArea(value: unknown): value is WidgetArea { return WIDGET_AREAS.includes(value as WidgetArea); }
function viewId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (isNativePanel(value)) return true;
  const parts = value.split("/");
  return parts.length === 2 && parts.every(isExtensionIdentifier);
}
export function normalizeWidgetLayout(value: unknown): WidgetLayoutPreferences {
  const placements: Record<string, WidgetArea> = {};
  const selected: Partial<Record<WidgetArea, string>> = {};
  if (record(value)) {
    if (record(value.placements)) {
      for (const [id, area] of Object.entries(value.placements)) {
        if (Object.keys(placements).length === MAX_PLACEMENTS) break;
        if (viewId(id) && isWidgetArea(area)) placements[id] = area;
      }
    }
    if (record(value.selected)) for (const area of WIDGET_AREAS) {
      if (viewId(value.selected[area])) selected[area] = value.selected[area];
    }
  }
  return { placements, selected, ...(record(value) && isWidgetArea(value.defaultArea) ? { defaultArea: value.defaultArea } : {}) };
}

/** Origin-local presentation preferences, never contribution registration or routing authority. */
export class WidgetLayout {
  private value: WidgetLayoutPreferences;
  private error = "";
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">, private defaultArea: WidgetArea = "right") {
    try {
      const raw = storage.getItem(WIDGET_LAYOUT_KEY);
      this.value = normalizeWidgetLayout(raw && raw.length <= 65536 ? JSON.parse(raw) : null);
    } catch { this.value = normalizeWidgetLayout(null); }
  }
  get preferences(): WidgetLayoutPreferences { return this.value; }
  get diagnostic(): string { return this.error; }
  area(id: string): WidgetArea {
    return this.value.placements[id] ?? (id === SESSIONS_PANEL ? "left" : id === TERMINALS_PANEL ? "main" : this.value.defaultArea ?? this.defaultArea);
  }
  /** Resolve only available panels. Temporary catalog/visibility loss never rewrites saved placements. */
  areasFor(available: readonly string[]): Record<string, WidgetArea> {
    const areas = Object.fromEntries(available.filter(viewId).map(id => [id, this.area(id)]));
    if (available.includes(TERMINALS_PANEL) && !Object.values(areas).includes("main")) areas[TERMINALS_PANEL] = "main";
    return areas;
  }
  replacement(id: string, target: WidgetArea, available: readonly string[]): string | null {
    const areas = this.areasFor(available);
    if (target === "main" || areas[id] !== "main" || available.some(other => other !== id && areas[other] === "main")) return null;
    return [TERMINALS_PANEL, SESSIONS_PANEL, ...available].find(other => other !== id && available.includes(other)) ?? null;
  }
  setDefaultArea(area: WidgetArea): void {
    if (!isWidgetArea(area)) return;
    this.value = { ...this.value, defaultArea: area };
    this.persist();
  }
  selection(area: WidgetArea, available: readonly string[]): string | null {
    const areas = this.areasFor(available);
    const members = available.filter(id => areas[id] === area);
    const saved = this.value.selected[area];
    return saved && members.includes(saved) ? saved : members.length === 1 ? members[0]! : null;
  }
  select(id: string): void {
    if (!viewId(id)) return;
    this.value = { ...this.value, selected: { ...this.value.selected, [this.area(id)]: id } };
    this.persist();
  }
  move(id: string, area: WidgetArea, available?: readonly string[]): boolean {
    if (!viewId(id) || !isWidgetArea(area) || (available && !available.includes(id))) return false;
    const from = available ? this.areasFor(available)[id]! : this.area(id);
    const replacement = available ? this.replacement(id, area, available) : null;
    if (available?.includes(TERMINALS_PANEL) && from === "main" && area !== "main" && !replacement && !available.some(other => other !== id && this.areasFor(available)[other] === "main")) {
      this.error = "Show another panel before moving the last Main panel.";
      return false;
    }
    const selected = { ...this.value.selected };
    if (from !== area && selected[from] === id) delete selected[from];
    selected[area] = id;
    if (replacement) {
      const previous = this.area(replacement);
      if (selected[previous] === replacement) delete selected[previous];
      selected.main = replacement;
    }
    // Keep the explicit action and Main replacement when bounding dormant preferences.
    this.value = normalizeWidgetLayout({ ...this.value, placements: { [id]: area, ...(replacement ? { [replacement]: "main" } : {}), ...Object.fromEntries(Object.entries(this.value.placements).filter(([key]) => key !== id && key !== replacement)) }, selected });
    this.persist();
    return true;
  }
  reset(): void {
    this.defaultArea = "right";
    this.value = normalizeWidgetLayout(null);
    this.persist();
  }
  private persist(): void {
    try { this.storage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(this.value)); this.error = ""; }
    catch { this.error = "Layout changed for this tab only; browser storage is unavailable."; }
  }
}
