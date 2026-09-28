import { SESSIONS_PANEL, TERMINALS_PANEL, type WidgetLayout, type WidgetArea } from "./widget-layout.ts";
import { createWorkspaceDrag } from "./workspace-drag.ts";

/** Only the Sessions host changes parent at desktop/navigation boundaries. */
export function createWorkspaceDocking(options: {
  readonly layout: WidgetLayout;
  readonly active: () => boolean;
  readonly sessionsPinned: () => boolean;
  readonly panels: () => readonly { id: string; title: string }[];
  readonly setNativePanels: (ids: readonly string[]) => void;
  readonly move: (id: string, area: WidgetArea) => void;
}): { sync(): void; dispose(): void } {
  const root = document.getElementById("workspace-shell")!;
  const sidebar = document.getElementById("desktop-sidebar")!;
  const handle = document.getElementById("workspace-sessions-drag")!;
  const anchor = document.createComment("Sessions home outside the terminal workspace");
  sidebar.before(anchor);
  const media = matchMedia("(min-width:769px)");
  const drag = createWorkspaceDrag({ ...options, root });
  const sync = () => {
    const active = media.matches && options.active();
    const dockSessions = active && options.sessionsPinned() && root.dataset.fullView === "none";
    const destination = dockSessions ? root : anchor.parentElement!;
    if (sidebar.parentElement !== destination) {
      drag.cancel();
      const focus = sidebar.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      const list = document.getElementById("sidebar-session-list")!;
      const scroll = list.scrollTop;
      if (dockSessions) root.append(sidebar); else anchor.before(sidebar);
      list.scrollTop = scroll;
      focus?.focus({ preventScroll: true });
    }
    if (!active) drag.cancel();
    sidebar.classList.toggle("workspace-native-panel", dockSessions);
    if (dockSessions) sidebar.classList.remove("collapsed");
    handle.hidden = !dockSessions;
    options.setNativePanels(active ? [TERMINALS_PANEL, ...(dockSessions ? [SESSIONS_PANEL] : [])] : []);
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer.observe(root, { attributes: true, attributeFilter: ["data-full-view"] });
  media.addEventListener("change", sync);
  sync();
  return { sync, dispose() { observer.disconnect(); media.removeEventListener("change", sync); drag.dispose(); } };
}
