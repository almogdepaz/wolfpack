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
  readonly setDragActive: (active: boolean) => void;
}

type Placement = "before" | "after";

interface PointerCandidate {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly originX: number;
  readonly originY: number;
  readonly card: HTMLElement;
  readonly moving: SessionOrderCardReference;
  timer: number | null;
}

interface HiddenCard {
  readonly element: HTMLElement;
  readonly display: string;
}

interface SessionOrderDragState {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly moving: SessionOrderCardReference;
  readonly card: HTMLElement;
  readonly cardStyle: string;
  readonly placeholder: HTMLElement;
  readonly originParent: HTMLElement;
  readonly originNextSibling: ChildNode | null;
  readonly hiddenCards: readonly HiddenCard[];
  readonly pointerOffsetX: number;
  readonly pointerOffsetY: number;
  target: SessionOrderCardReference | null;
  placement: Placement;
}

const MOUSE_DRAG_THRESHOLD = 5;
const TOUCH_SCROLL_THRESHOLD = 10;
const TOUCH_HOLD_MS = 300;
const INTERACTIVE_CONTROL_SELECTOR = "button:not(.card-open), a, input, select, textarea, [contenteditable='true']";

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
  return left.listId === right.listId
    && left.machineUrl === right.machineUrl
    && left.parentId === right.parentId;
}

function cardForReference(reference: SessionOrderCardReference): HTMLElement | null {
  const list = document.getElementById(reference.listId);
  return Array.from(list?.querySelectorAll<HTMLElement>(".card[data-session-order-id]") ?? [])
    .find(card => card.dataset.sessionOrderId === reference.sessionId
      && card.dataset.sessionOrderMachine === reference.machineUrl) ?? null;
}

function scopeReferenceAtPoint(element: Element | null, moving: SessionOrderCardReference): SessionOrderCardReference | null {
  let reference = cardReference(element);
  const visited = new Set<string>();
  while (reference && !sameScope(reference, moving)) {
    if (reference.listId !== moving.listId || reference.machineUrl !== moving.machineUrl || !reference.parentId) {
      return null;
    }
    if (visited.has(reference.parentId)) return null;
    visited.add(reference.parentId);
    reference = cardReference(cardForReference({
      ...reference,
      sessionId: reference.parentId,
    }));
  }
  return reference;
}

function descendantCards(card: HTMLElement): HTMLElement[] {
  const descendants: HTMLElement[] = [];
  const descendantIds = new Set([card.dataset.sessionOrderId ?? ""]);
  let candidate = card.nextElementSibling;
  while (candidate instanceof HTMLElement && candidate.matches(".card[data-session-order-id]")) {
    const parentId = candidate.dataset.sessionOrderParent ?? "";
    if (!descendantIds.has(parentId)) break;
    descendants.push(candidate);
    descendantIds.add(candidate.dataset.sessionOrderId ?? "");
    candidate = candidate.nextElementSibling;
  }
  return descendants;
}

function animateLayout(cards: readonly HTMLElement[], previousTops: ReadonlyMap<HTMLElement, number>): void {
  for (const card of cards) {
    const previousTop = previousTops.get(card);
    if (previousTop === undefined) continue;
    const delta = previousTop - card.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    card.animate(
      [{ translate: `0 ${delta}px` }, { translate: "0 0" }],
      { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }
}

function focusCard(reference: SessionOrderCardReference): void {
  const focus = (): void => cardForReference(reference)?.querySelector<HTMLElement>(".card-open")?.focus();
  if (reference.listId === "sidebar-session-list") requestAnimationFrame(focus);
  else focus();
}

export function bindSessionOrderEvents(handlers: SessionOrderUiHandlers): void {
  let candidate: PointerCandidate | null = null;
  let drag: SessionOrderDragState | null = null;
  let suppressNextCardClick = false;

  const clearCandidate = (): void => {
    if (candidate?.timer != null) window.clearTimeout(candidate.timer);
    candidate = null;
  };

  const restoreDraggedCard = (active: SessionOrderDragState): void => {
    active.card.classList.remove("session-order-floating");
    active.card.style.cssText = active.cardStyle;
    active.originParent.insertBefore(active.card, active.originNextSibling);
    active.placeholder.remove();
    for (const hidden of active.hiddenCards) hidden.element.style.display = hidden.display;
    document.body.classList.remove("session-order-pointer-active");
    handlers.setDragActive(false);
  };

  const finishDrag = (commit: boolean): void => {
    const completed = drag;
    drag = null;
    clearCandidate();
    if (!completed) return;
    restoreDraggedCard(completed);
    if (completed.pointerType !== "touch") {
      suppressNextCardClick = true;
      window.setTimeout(() => { suppressNextCardClick = false; }, 0);
    }
    if (commit && completed.target
      && handlers.move(completed.moving, completed.target, completed.placement)) {
      focusCard(completed.moving);
    }
  };

  const startDrag = (pending: PointerCandidate, clientX: number, clientY: number): void => {
    if (candidate !== pending || drag) return;
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    candidate = null;

    const cardRect = pending.card.getBoundingClientRect();
    const followers = descendantCards(pending.card);
    const lastRect = followers.at(-1)?.getBoundingClientRect() ?? cardRect;
    const placeholder = document.createElement("div");
    placeholder.className = pending.card.classList.contains("sub-session-card")
      ? "session-order-placeholder sub-session-placeholder"
      : "session-order-placeholder";
    placeholder.style.height = `${lastRect.bottom - cardRect.top}px`;
    placeholder.setAttribute("aria-hidden", "true");

    const originParent = pending.card.parentElement;
    if (!originParent) return;
    const originNextSibling = pending.card.nextSibling;
    originParent.insertBefore(placeholder, pending.card);
    const hiddenCards = followers.map(element => ({ element, display: element.style.display }));
    for (const hidden of hiddenCards) hidden.element.style.display = "none";

    const cardStyle = pending.card.style.cssText;
    pending.card.classList.add("session-order-floating");
    pending.card.style.left = `${cardRect.left}px`;
    pending.card.style.top = `${cardRect.top}px`;
    pending.card.style.width = `${cardRect.width}px`;
    pending.card.style.height = `${cardRect.height}px`;
    document.body.appendChild(pending.card);
    document.body.classList.add("session-order-pointer-active");
    handlers.setDragActive(true);
    try { pending.card.setPointerCapture(pending.pointerId); } catch { /* synthetic pointer event */ }

    drag = {
      pointerId: pending.pointerId,
      pointerType: pending.pointerType,
      moving: pending.moving,
      card: pending.card,
      cardStyle,
      placeholder,
      originParent,
      originNextSibling,
      hiddenCards,
      pointerOffsetX: clientX - cardRect.left,
      pointerOffsetY: clientY - cardRect.top,
      target: null,
      placement: "before",
    };
  };

  const previewTarget = (clientX: number, clientY: number): void => {
    if (!drag) return;
    drag.card.style.left = `${clientX - drag.pointerOffsetX}px`;
    drag.card.style.top = `${clientY - drag.pointerOffsetY}px`;

    const target = scopeReferenceAtPoint(document.elementFromPoint(clientX, clientY), drag.moving);
    if (!target || target.sessionId === drag.moving.sessionId) return;
    const targetCard = cardForReference(target);
    if (!targetCard) return;
    const targetRect = targetCard.getBoundingClientRect();
    const placement: Placement = clientY > targetRect.top + targetRect.height / 2 ? "after" : "before";
    if (drag.target?.sessionId === target.sessionId && drag.placement === placement) return;

    const visibleCards = Array.from(drag.originParent.querySelectorAll<HTMLElement>(".card[data-session-order-id]"))
      .filter(card => card.style.display !== "none");
    const previousTops = new Map(visibleCards.map(card => [card, card.getBoundingClientRect().top]));
    if (placement === "before") {
      drag.originParent.insertBefore(drag.placeholder, targetCard);
    } else {
      const targetBlock = descendantCards(targetCard);
      drag.originParent.insertBefore(drag.placeholder, targetBlock.at(-1)?.nextSibling ?? targetCard.nextSibling);
    }
    animateLayout(visibleCards, previousTops);
    drag.target = target;
    drag.placement = placement;
  };

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (suppressNextCardClick && target.closest(".card")) {
      suppressNextCardClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const reset = target.closest<HTMLElement>(".session-order-reset");
    if (!reset) return;
    event.preventDefault();
    event.stopPropagation();
    handlers.reset(reset.dataset.sessionOrderMachine ?? "");
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      finishDrag(false);
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".card-open") || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const moving = cardReference(target);
    if (!moving) return;
    const offset = event.key === "ArrowUp" ? -1 : 1;
    if (!handlers.moveByOffset(moving, offset)) return;
    event.preventDefault();
    event.stopPropagation();
    focusCard(moving);
  });

  const beginCandidate = (
    target: EventTarget | null,
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void => {
    if (!(target instanceof Element) || target.closest(INTERACTIVE_CONTROL_SELECTOR)) return;
    const card = target.closest<HTMLElement>(".card[data-session-order-id]");
    const moving = cardReference(card);
    if (!card || !moving) return;
    clearCandidate();
    candidate = {
      pointerId,
      pointerType,
      originX: clientX,
      originY: clientY,
      card,
      moving,
      timer: null,
    };
    if (pointerType !== "mouse") {
      const pending = candidate;
      pending.timer = window.setTimeout(() => startDrag(pending, pending.originX, pending.originY), TOUCH_HOLD_MS);
    }
  };

  document.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    beginCandidate(event.target, event.pointerId, event.pointerType, event.clientX, event.clientY);
  });

  document.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      previewTarget(event.clientX, event.clientY);
      return;
    }
    if (candidate?.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - candidate.originX, event.clientY - candidate.originY);
    if (candidate.pointerType === "mouse" && distance >= MOUSE_DRAG_THRESHOLD) {
      const pending = candidate;
      startDrag(pending, event.clientX, event.clientY);
      event.preventDefault();
      previewTarget(event.clientX, event.clientY);
    } else if (candidate.pointerType !== "mouse" && distance >= TOUCH_SCROLL_THRESHOLD) {
      clearCandidate();
    }
  }, { passive: false });

  document.addEventListener("pointerup", event => {
    if (event.pointerType === "touch") return;
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      finishDrag(true);
    } else if (candidate?.pointerId === event.pointerId) {
      clearCandidate();
    }
  });
  document.addEventListener("pointercancel", event => {
    if (event.pointerType === "touch") return;
    if (drag?.pointerId === event.pointerId) finishDrag(false);
    else if (candidate?.pointerId === event.pointerId) clearCandidate();
  });

  const touchById = (touches: TouchList, identifier: number): Touch | null =>
    Array.from(touches).find(touch => touch.identifier === identifier) ?? null;

  document.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) {
      clearCandidate();
      return;
    }
    const touch = event.touches[0];
    beginCandidate(event.target, touch.identifier, "touch", touch.clientX, touch.clientY);
  }, { passive: true });

  document.addEventListener("touchmove", event => {
    if (drag) {
      const touch = touchById(event.touches, drag.pointerId);
      if (!touch) return;
      event.preventDefault();
      previewTarget(touch.clientX, touch.clientY);
      return;
    }
    if (!candidate || candidate.pointerType !== "touch") return;
    const touch = touchById(event.touches, candidate.pointerId);
    if (!touch) return;
    const distance = Math.hypot(touch.clientX - candidate.originX, touch.clientY - candidate.originY);
    if (distance >= TOUCH_SCROLL_THRESHOLD) clearCandidate();
  }, { passive: false });

  document.addEventListener("touchend", event => {
    const identifier = drag?.pointerId ?? candidate?.pointerId;
    if (identifier === undefined || !touchById(event.changedTouches, identifier)) return;
    if (drag) {
      event.preventDefault();
      finishDrag(true);
    } else {
      clearCandidate();
    }
  }, { passive: false });
  document.addEventListener("touchcancel", event => {
    const identifier = drag?.pointerId ?? candidate?.pointerId;
    if (identifier === undefined || !touchById(event.changedTouches, identifier)) return;
    if (drag) finishDrag(false);
    else clearCandidate();
  });
  window.addEventListener("blur", () => finishDrag(false));
}
