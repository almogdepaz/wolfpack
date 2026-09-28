import { isNativePanel, WidgetLayout, WIDGET_AREAS, type WidgetArea } from "./widget-layout.ts";

/** Fixed logical docks, including currently empty areas. No free-form geometry. */
export function dockTargetAt(x: number, y: number, box: Pick<DOMRect, "left" | "top" | "width" | "height">): WidgetArea | null {
  if (![x, y, box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return null;
  const dx = (x - box.left) / box.width, dy = (y - box.top) / box.height;
  if (dx < 0 || dx > 1 || dy < 0 || dy > 1) return null;
  return dx < .25 ? "left" : dx > .75 ? "right" : dy > .7 ? "bottom" : "main";
}

/** One desktop gesture owner. Hover only paints four targets; only a valid drop mutates layout. */
export function createWorkspaceDrag(options: {
  readonly root: HTMLElement;
  readonly layout: WidgetLayout;
  readonly active: () => boolean;
  readonly panels: () => readonly { id: string; title: string }[];
  readonly move: (id: string, area: WidgetArea) => void;
}): { cancel(): void; dispose(): void } {
  const { root, layout } = options;
  const events = new AbortController(), media = matchMedia("(min-width:769px)");
  const status = document.getElementById("workspace-dock-status")!;
  type Gesture = { id: string; title: string; handle: HTMLButtonElement; pointer: number | null; x: number; y: number; box: DOMRect; target: WidgetArea | null; overlay: HTMLElement | null };
  let gesture: Gesture | null = null;
  const available = () => options.panels().map(panel => panel.id);
  const valid = (g: Gesture) => media.matches && options.active() && !document.hidden && g.handle.isConnected && !g.handle.disabled && g.handle.dataset.dockHandle === g.id && g.handle.getClientRects().length > 0 && (g.id ? available().includes(g.id) : available().every(isNativePanel));
  const allowed = (g: Gesture, area: WidgetArea) => !g.id || layout.canMove(g.id, area, available());
  const restoreFocus = (g: Gesture) => {
    const handle = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-dock-handle]")).find(node => node.dataset.dockHandle === g.id && node.getClientRects().length > 0);
    handle?.focus({ preventScroll: true });
  };
  const finish = (commit: boolean, focus = true) => {
    const g = gesture; if (!g) return;
    const drop = commit && g.overlay && g.target && valid(g) && allowed(g, g.target) ? g.target : null;
    gesture = null; observer.disconnect();
    g.overlay?.remove(); root.classList.remove("workspace-dragging");
    if (g.pointer !== null && g.handle.hasPointerCapture(g.pointer)) g.handle.releasePointerCapture(g.pointer);
    if (drop) {
      const from = g.id ? layout.areasFor(available())[g.id] : layout.area("");
      if (drop !== from) options.move(g.id, drop);
      status.textContent = layout.diagnostic || `${g.title} docked ${drop}.`;
    } else if (g.overlay) status.textContent = "Docking cancelled.";
    if (focus) restoreFocus(g);
  };
  const paint = () => {
    const g = gesture; if (!g?.overlay) return;
    for (const node of g.overlay.children) {
      const area = (node as HTMLElement).dataset.dockTarget as WidgetArea;
      const active = area === g.target, enabled = allowed(g, area);
      const replacement = active && g.id ? layout.replacement(g.id, area, available()) : null;
      const hint = !enabled ? " — Main must keep a panel" : replacement ? ` — ${options.panels().find(panel => panel.id === replacement)?.title} moves to Main` : "";
      node.textContent = area[0]!.toUpperCase() + area.slice(1) + hint;
      node.setAttribute("data-active", String(active));
      node.setAttribute("aria-disabled", String(!enabled));
    }
    if (!g.target) { status.textContent = "Outside workspace. Release to cancel."; return; }
    const replacement = g.id ? layout.replacement(g.id, g.target, available()) : null;
    status.textContent = !allowed(g, g.target) ? "Main must keep a panel. Release to cancel." : `${g.title} → ${g.target}.${replacement ? ` ${options.panels().find(panel => panel.id === replacement)?.title} moves to Main.` : " Occupied docks share tabs."} Enter to dock, Escape to cancel.`;
  };
  const reveal = (g: Gesture) => {
    const overlay = document.createElement("div"); overlay.className = "workspace-dock-targets"; overlay.setAttribute("aria-hidden", "true");
    for (const area of WIDGET_AREAS) { const target = document.createElement("div"); target.dataset.dockTarget = area; target.textContent = area[0]!.toUpperCase() + area.slice(1); overlay.append(target); }
    g.overlay = overlay; root.append(overlay); root.classList.add("workspace-dragging"); paint();
  };
  // Observe availability only for the lifetime of a gesture; no idle observer/polling.
  const observer = new MutationObserver(() => { if (gesture && !valid(gesture)) finish(false); });
  const start = (target: EventTarget | null, pointer: number | null, x = 0, y = 0): Gesture | null => {
    if (gesture || !(target instanceof Element)) return null;
    const handle = target.closest<HTMLButtonElement>("button[data-dock-handle]");
    if (!handle || !root.contains(handle)) return null;
    const id = handle.dataset.dockHandle!;
    const panel = options.panels().find(panel => panel.id === id);
    if (!panel && id) return null;
    const g: Gesture = { id, title: panel?.title ?? "Widgets", handle, pointer, x, y, box: root.getBoundingClientRect(), target: id ? layout.areasFor(available())[id] ?? null : layout.area(""), overlay: null };
    if (!valid(g)) return null;
    gesture = g; handle.focus({ preventScroll: true });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "data-dock-handle"] });
    return g;
  };
  root.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch") return;
    const g = start(event.target, event.pointerId, event.clientX, event.clientY); if (!g) return;
    event.preventDefault(); event.stopPropagation(); g.handle.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  root.addEventListener("pointermove", event => {
    const g = gesture; if (!g || g.pointer !== event.pointerId) return;
    if (!valid(g)) { finish(false); return; }
    if (!g.overlay && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 6) return;
    const target = dockTargetAt(event.clientX, event.clientY, g.box);
    if (!g.overlay) { g.target = target; reveal(g); }
    else if (target !== g.target) { g.target = target; paint(); }
    event.preventDefault();
  }, { signal: events.signal });
  root.addEventListener("pointerup", event => {
    if (gesture?.pointer !== event.pointerId) return;
    gesture.target = dockTargetAt(event.clientX, event.clientY, gesture.box);
    event.preventDefault(); event.stopPropagation(); finish(true);
  }, { signal: events.signal });
  for (const type of ["pointercancel", "lostpointercapture"] as const) root.addEventListener(type, event => { if (gesture?.pointer === event.pointerId) finish(false); }, { signal: events.signal });
  document.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (!gesture && (event.key === " " || event.key === "Enter")) {
      const g = start(event.target, null); if (!g) return;
      event.preventDefault(); event.stopImmediatePropagation(); reveal(g); return;
    }
    if (!gesture) return;
    if (event.key === "Tab") { finish(false, false); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(false); return; }
    if (gesture.pointer !== null) return;
    const directions: Readonly<Record<string, WidgetArea>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "main", ArrowDown: "bottom" };
    const area = directions[event.key];
    if (area) { event.preventDefault(); event.stopImmediatePropagation(); gesture.target = area; paint(); }
    else if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
  }, { capture: true, signal: events.signal });
  // Navigation/visibility/geometry changes invalidate the original gesture and scope.
  const cancel = () => finish(false, false);
  document.addEventListener("focusin", event => { if (gesture?.pointer === null && event.target !== gesture.handle) cancel(); }, { signal: events.signal });
  for (const type of ["blur", "resize", "pagehide"]) window.addEventListener(type, cancel, { signal: events.signal });
  for (const type of ["visibilitychange", "wolfpack-extension-scope-change"]) document.addEventListener(type, cancel, { signal: events.signal });
  media.addEventListener("change", cancel);
  return { cancel, dispose() { cancel(); events.abort(); media.removeEventListener("change", cancel); } };
}
