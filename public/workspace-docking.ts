import { isWidgetArea, SESSIONS_PANEL, TERMINALS_PANEL, WidgetLayout, WIDGET_AREAS, type WidgetArea } from "./widget-layout.ts";

/** Desktop native-panel menus. Only the Sessions host changes parent at navigation boundaries. */
export function createWorkspaceDocking(options: {
  readonly layout: WidgetLayout;
  readonly active: () => boolean;
  readonly sessionsPinned: () => boolean;
  readonly panels: () => readonly { id: string; title: string }[];
  readonly setNativePanels: (ids: readonly string[]) => void;
  readonly move: (id: string, area: WidgetArea) => void;
  readonly reset: () => void;
}): { sync(): void; dispose(): void } {
  const root = document.getElementById("workspace-shell")!;
  const sidebar = document.getElementById("desktop-sidebar")!;
  const dialog = document.getElementById("workspace-move-dialog") as HTMLDialogElement;
  const button = document.getElementById("workspace-move-open") as HTMLButtonElement;
  const status = dialog.querySelector<HTMLElement>("[data-docking-status]")!;
  const anchor = document.createComment("Sessions home outside the terminal workspace");
  sidebar.before(anchor);
  const events = new AbortController();
  const media = matchMedia("(min-width:769px)");
  const renderMenu = () => {
    const panels = options.panels(), ids = panels.map(panel => panel.id);
    for (const select of dialog.querySelectorAll<HTMLSelectElement>("[data-native-placement]")) {
      const id = select.dataset.nativePlacement!;
      select.disabled = !ids.includes(id);
      const selected = options.layout.areasFor(ids)[id] ?? options.layout.area(id);
      select.replaceChildren();
      for (const area of WIDGET_AREAS) {
        const option = document.createElement("option"); option.value = area;
        const replacement = options.layout.replacement(id, area, ids);
        option.textContent = area[0]!.toUpperCase() + area.slice(1) + (replacement ? ` — ${panels.find(panel => panel.id === replacement)?.title} moves to Main` : "");
        option.disabled = selected === "main" && area !== "main" && !replacement && !ids.some(other => other !== id && options.layout.areasFor(ids)[other] === "main");
        select.append(option);
      }
      select.value = selected;
    }
    status.textContent = options.layout.diagnostic || (!ids.includes(SESSIONS_PANEL) ? "Pin Sessions to place it in a dock. The terminal grid always moves as one panel." : "Occupied areas share tabs. Main always keeps a panel. The terminal grid moves as one panel.");
  };
  const sync = () => {
    const active = media.matches && options.active();
    // Focused views keep the existing global Sessions controls available.
    const dockSessions = active && options.sessionsPinned() && root.dataset.fullView === "none";
    const destination = dockSessions ? root : anchor.parentElement!;
    if (sidebar.parentElement !== destination) {
      const focus = sidebar.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      const list = document.getElementById("sidebar-session-list")!;
      const scroll = list.scrollTop;
      if (dockSessions) root.append(sidebar); else anchor.before(sidebar);
      list.scrollTop = scroll;
      focus?.focus({ preventScroll: true });
    }
    sidebar.classList.toggle("workspace-native-panel", dockSessions);
    if (dockSessions) sidebar.classList.remove("collapsed");
    button.hidden = !active;
    options.setNativePanels(active ? [TERMINALS_PANEL, ...(dockSessions ? [SESSIONS_PANEL] : [])] : []);
    if (dialog.open) {
      if (!active) dialog.close(); else renderMenu();
    }
  };
  button.addEventListener("click", () => { renderMenu(); dialog.showModal(); }, { signal: events.signal });
  dialog.querySelector("[data-docking-close]")!.addEventListener("click", () => dialog.close(), { signal: events.signal });
  dialog.addEventListener("close", () => {
    const target = button.getClientRects().length ? button : Array.from(root.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]')).find(tab => tab.getClientRects().length);
    target?.focus({ preventScroll: true });
  }, { signal: events.signal });
  dialog.querySelector("[data-docking-reset]")!.addEventListener("click", () => { options.reset(); renderMenu(); }, { signal: events.signal });
  for (const select of dialog.querySelectorAll<HTMLSelectElement>("[data-native-placement]")) select.addEventListener("change", () => {
    if (!media.matches || !options.active() || !isWidgetArea(select.value)) return;
    options.move(select.dataset.nativePlacement!, select.value); renderMenu();
  }, { signal: events.signal });
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer.observe(root, { attributes: true, attributeFilter: ["data-full-view"] });
  media.addEventListener("change", sync);
  sync();
  return { sync, dispose() { observer.disconnect(); media.removeEventListener("change", sync); events.abort(); dialog.close(); } };
}
