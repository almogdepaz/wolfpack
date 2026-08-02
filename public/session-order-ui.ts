import type { SessionOrderIdentity } from "./session-order";

export interface SessionOrderCardReference extends SessionOrderIdentity {
  readonly parentId: string;
  readonly listId: string;
  readonly name: string;
}

export interface SessionOrderUiHandlers {
  readonly move: (
    moving: SessionOrderCardReference,
    target: SessionOrderCardReference,
    placement: "before" | "after",
  ) => boolean;
  readonly moveByOffset: (moving: SessionOrderCardReference, offset: -1 | 1) => boolean;
  readonly reset: (machineUrl: string) => void;
}

interface SessionOrderDragState {
  readonly moving: SessionOrderCardReference;
  target: SessionOrderCardReference | null;
  placement: "before" | "after";
}

function cardReference(element: Element | null): SessionOrderCardReference | null {
  const card = element?.closest<HTMLElement>(".card[data-session-order-id]");
  const list = card?.closest<HTMLElement>("#session-list, #sidebar-session-list");
  const sessionId = card?.dataset.sessionOrderId;
  const machineUrl = card?.dataset.sessionOrderMachine;
  if (!card || !list?.id || sessionId === undefined || machineUrl === undefined) return null;
  return {
    machineUrl,
    sessionId,
    parentId: card.dataset.sessionOrderParent ?? "",
    listId: list.id,
    name: card.querySelector(".card-name")?.firstChild?.textContent ?? sessionId,
  };
}

function sameScope(left: SessionOrderCardReference, right: SessionOrderCardReference): boolean {
  return left.machineUrl === right.machineUrl && left.parentId === right.parentId;
}

function clearDragClasses(): void {
  document.querySelectorAll(".session-order-drop-before, .session-order-drop-after, .session-order-dragging")
    .forEach(element => element.classList.remove(
      "session-order-drop-before",
      "session-order-drop-after",
      "session-order-dragging",
    ));
}

function focusHandle(reference: SessionOrderCardReference): void {
  const focus = (): void => {
    const list = document.getElementById(reference.listId);
    const handle = Array.from(list?.querySelectorAll<HTMLElement>(".session-order-handle") ?? [])
      .find(candidate => {
        const card = candidate.closest<HTMLElement>(".card[data-session-order-id]");
        return card?.dataset.sessionOrderId === reference.sessionId
          && card.dataset.sessionOrderMachine === reference.machineUrl;
      });
    handle?.focus();
  };
  if (reference.listId === "sidebar-session-list") requestAnimationFrame(focus);
  else focus();
}

export function bindSessionOrderEvents(handlers: SessionOrderUiHandlers): void {
  let drag: SessionOrderDragState | null = null;
  let pointerId: number | null = null;

  const markDropTarget = (target: SessionOrderCardReference, placement: "before" | "after"): void => {
    document.querySelectorAll(".session-order-drop-before, .session-order-drop-after")
      .forEach(element => element.classList.remove("session-order-drop-before", "session-order-drop-after"));
    const card = Array.from(document.querySelectorAll<HTMLElement>(`#${target.listId} .card[data-session-order-id]`))
      .find(candidate => candidate.dataset.sessionOrderId === target.sessionId
        && candidate.dataset.sessionOrderMachine === target.machineUrl);
    card?.classList.add(placement === "before" ? "session-order-drop-before" : "session-order-drop-after");
  };

  const updateDragTarget = (clientX: number, clientY: number): void => {
    if (!drag) return;
    const element = document.elementFromPoint(clientX, clientY);
    const target = cardReference(element);
    if (!target || target.sessionId === drag.moving.sessionId || !sameScope(drag.moving, target)) {
      drag.target = null;
      document.querySelectorAll(".session-order-drop-before, .session-order-drop-after")
        .forEach(candidate => candidate.classList.remove("session-order-drop-before", "session-order-drop-after"));
      return;
    }
    const card = element?.closest<HTMLElement>(".card[data-session-order-id]");
    const placement = card && clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2
      ? "after"
      : "before";
    drag.target = target;
    drag.placement = placement;
    markDropTarget(target, placement);
  };

  const finishDrag = (restoreFocus = false): void => {
    const completed = drag;
    drag = null;
    pointerId = null;
    clearDragClasses();
    if (completed?.target && handlers.move(completed.moving, completed.target, completed.placement) && restoreFocus) {
      focusHandle(completed.moving);
    }
  };

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const reset = target.closest<HTMLElement>(".session-order-reset");
    if (!reset) return;
    event.preventDefault();
    event.stopPropagation();
    handlers.reset(reset.dataset.sessionOrderMachine ?? "");
  });

  document.addEventListener("keydown", event => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".session-order-handle")) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const moving = cardReference(target);
    if (!moving) return;
    const offset = event.key === "ArrowUp" ? -1 : 1;
    if (!handlers.moveByOffset(moving, offset)) return;
    event.preventDefault();
    event.stopPropagation();
    focusHandle(moving);
  });

  document.addEventListener("dragstart", event => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".session-order-handle")) return;
    const moving = cardReference(target);
    if (!moving) return;
    drag = { moving, target: null, placement: "before" };
    event.dataTransfer?.setData("text/plain", moving.sessionId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    target.closest(".card")?.classList.add("session-order-dragging");
  });
  document.addEventListener("dragover", event => {
    if (!drag) return;
    updateDragTarget(event.clientX, event.clientY);
    if (drag.target) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  });
  document.addEventListener("drop", event => {
    if (!drag?.target) return;
    event.preventDefault();
    finishDrag();
  });
  document.addEventListener("dragend", () => finishDrag());

  document.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse") return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".session-order-handle")) return;
    const moving = cardReference(target);
    if (!moving) return;
    event.preventDefault();
    pointerId = event.pointerId;
    drag = { moving, target: null, placement: "before" };
    target.closest(".card")?.classList.add("session-order-dragging");
    try { (target as HTMLElement).setPointerCapture(event.pointerId); } catch { /* synthetic pointer event */ }
  });
  document.addEventListener("pointermove", event => {
    if (pointerId !== event.pointerId || !drag) return;
    event.preventDefault();
    updateDragTarget(event.clientX, event.clientY);
  });
  document.addEventListener("pointerup", event => {
    if (pointerId !== event.pointerId) return;
    event.preventDefault();
    finishDrag(true);
  });
  document.addEventListener("pointercancel", event => {
    if (pointerId === event.pointerId) finishDrag();
  });
}
