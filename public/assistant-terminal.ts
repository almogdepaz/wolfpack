import type { PtyTerminalController, PtyTerminalControllerOpts } from "./pty-terminal-controller";
import { classifyDisconnect, handleTakeControlClick } from "../src/take-control-logic";
import { scheduleTakeControlFallback } from "./take-control-coordinator";
import { revealTerminalConflict } from "./terminal-loading-ui";

export interface AssistantTerminalTarget {
  readonly session: string;
  readonly machine: string;
  readonly sessionId?: string;
}

/** The pinned assistant's projection only: deliberately outside the watched
 * terminal pool, currentSession, grid, acknowledgements and refresh cadence. */
export function createAssistantTerminal(deps: {
  createController: (opts: PtyTerminalControllerOpts) => PtyTerminalController;
  scrollback: number;
  createConflictOverlay: (message: string, label: string, click: () => void) => HTMLElement;
}) {
  const pane = document.getElementById("assistant-pane")!;
  const container = document.getElementById("assistant-pty")!;
  const input = document.getElementById("assistant-pty-input")!;
  const list = document.querySelector<HTMLElement>(".assistant-column")!;
  const status = document.getElementById("assistant-pane-status")!;
  const wide = matchMedia("(min-width: 1100px)");
  let active = false;
  let target: AssistantTerminalTarget | null = null;
  let mounted: AssistantTerminalTarget | null = null;
  let controller: PtyTerminalController | null = null;
  let overlay: HTMLElement | null = null;
  let takeoverTimer: number | undefined;
  const visible = () => active && wide.matches && document.visibilityState === "visible";
  const sameTarget = (a: AssistantTerminalTarget | null, b: AssistantTerminalTarget | null) =>
    a?.session === b?.session && a?.machine === b?.machine && a?.sessionId === b?.sessionId;
  let inputRequested = false;
  const backToList = () => { inputRequested = false; list.focus({ preventScroll: true }); };
  document.getElementById("assistant-pane-list")!.onclick = backToList;
  document.getElementById("assistant-pane-focus")!.onclick = () => { inputRequested = true; controller?.focus(); };
  input.addEventListener("pointerdown", () => { inputRequested = true; });
  pane.addEventListener("keydown", event => {
    // Tab is an explicit keyboard opt-in too; native mount focus is not.
    if (event.key === "Tab") inputRequested = true;
    if (event.key !== "Escape" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation(); // Capture before Ghostty consumes the chord as stdin.
    backToList();
  }, true);
  list.addEventListener("focusin", () => { inputRequested = false; });
  // Ghostty.open() focuses its element, including a deferred focus, independently
  // of the controller's hydration shouldFocus. Gate that native mount focus here;
  // explicit pointer / Focus terminal actions still use Ghostty's real input.
  input.addEventListener("focusin", () => { if (!inputRequested) backToList(); });

  function clearOverlay() {
    clearTimeout(takeoverTimer);
    takeoverTimer = undefined;
    overlay?.remove();
    overlay = null;
    input.inert = false;
  }
  function release() {
    const hadFocus = pane.contains(document.activeElement);
    inputRequested = false;
    clearOverlay();
    const old = controller;
    controller = null;
    mounted = null;
    old?.dispose(); // cancels an in-flight mount, socket, hydration, resize observer and renderer
    input.replaceChildren();
    container.classList.remove("hydrating", "hydrated");
    if (hadFocus && active && document.visibilityState === "visible") backToList();
  }
  function appendOverlay(element: HTMLElement) {
    // Pane dialogs do not make the adjacent focus list modal/inert.
    element.removeAttribute("aria-modal");
    input.inert = true;
    container.append(element);
  }
  function showConflict(owner: PtyTerminalController) {
    clearOverlay();
    revealTerminalConflict(container, owner.hydration);
    status.textContent = "active elsewhere";
    overlay = deps.createConflictOverlay("Session active on another device", "Take Control", () => {
      if (controller !== owner) return;
      if (handleTakeControlClick(owner.isConnected) === "send-take-control") {
        owner.sendTakeControl();
        clearTimeout(takeoverTimer);
        takeoverTimer = scheduleTakeControlFallback({
          getTransport: () => controller === owner ? owner : null,
          isPending: () => !!overlay,
          prepareRetry: () => { takeoverTimer = undefined; },
        });
      } else owner.reconnect({ takeControl: true });
      // Only control_granted dismisses the gate; no automatic reclaim.
    });
    // Keep dialog controls outside Ghostty's focus/keydown boundary. While
    // blocked, skip the terminal input rather than bouncing Tab back to the list.
    appendOverlay(overlay);
  }
  function showFailure(owner: PtyTerminalController, message: string) {
    clearOverlay();
    revealTerminalConflict(container, owner.hydration);
    status.textContent = message;
    overlay = deps.createConflictOverlay(message, "Reconnect", () => {
      if (controller !== owner) return;
      release();
      sync();
    });
    appendOverlay(overlay);
  }
  async function mount(next: AssistantTerminalTarget) {
    status.textContent = "connecting";
    const owner = deps.createController({
      session: next.session,
      machine: next.machine,
      scrollback: deps.scrollback,
      getHydrationElement: () => container,
      // Hydration/reconnect must never move keyboard focus from the list.
      shouldFocus: () => false,
      shouldReconnect: () => controller === owner && visible(),
      onOpen: () => { if (controller === owner) { clearOverlay(); status.textContent = "connecting"; } },
      onHydrated: () => { if (controller === owner && !overlay) status.textContent = "click to talk"; },
      onViewerConflict: () => { if (controller === owner) showConflict(owner); },
      onControlGranted: () => { if (controller === owner) { clearOverlay(); status.textContent = "connecting"; } },
      onReconnecting: () => { if (controller === owner) status.textContent = "reconnecting"; },
      onReconnectExhausted: () => { if (controller === owner) showFailure(owner, "terminal offline"); },
      onRouteUnavailable: () => { if (controller === owner) showFailure(owner, "machine unavailable"); },
      onDisconnected: (code, reason) => {
        if (controller !== owner) return;
        const action = classifyDisconnect(code, reason);
        if (action === "displaced") showConflict(owner);
        else if (action === "session-ended" || action === "pty-exited") showFailure(owner, "terminal ended");
        else owner.scheduleReconnect();
      },
    });
    controller = owner;
    mounted = next;
    try {
      await owner.mount(input);
      if (controller !== owner) return;
      if (!owner.term) { showFailure(owner, "terminal unavailable"); return; }
      owner.connect();
    } catch (error) {
      if (controller !== owner) return;
      console.error("[assistant-pane] terminal mount failed", error);
      owner.dispose();
      showFailure(owner, "terminal unavailable");
    }
  }
  function sync() {
    const show = visible();
    pane.hidden = !show;
    if (!show || !target) {
      if (controller) release();
      status.textContent = "assistant unavailable";
      return;
    }
    if (controller && sameTarget(mounted, target)) return;
    release();
    void mount(target);
  }
  wide.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  return {
    setTarget(next: AssistantTerminalTarget | null) { target = next; sync(); },
    setActive(next: boolean) {
      const opening = next && !active;
      active = next;
      if (opening && wide.matches) backToList();
      sync();
    },
  };
}
