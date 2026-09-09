export interface MachineGroupReference {
  readonly machine: string;
  readonly surface: "main" | "sidebar";
  readonly name: string;
}

export interface MachineGroupUiHandlers {
  readonly move: (moving: MachineGroupReference, target: MachineGroupReference, placement: "before" | "after") => boolean;
  readonly moveByOffset: (moving: MachineGroupReference, offset: -1 | 1) => boolean;
  readonly setDragActive: (active: boolean) => void;
}

interface MachineGroupDragState {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly group: HTMLElement;
  readonly moving: MachineGroupReference;
  readonly originalStyle: string;
  readonly originParent: HTMLElement;
  readonly originNextSibling: ChildNode | null;
  readonly placeholder: HTMLElement;
  readonly pointerOffsetX: number;
  readonly pointerOffsetY: number;
  target: MachineGroupReference | null;
  placement: "before" | "after";
}

interface MachineGroupMoveOptions {
  readonly button: HTMLButtonElement;
  readonly options: HTMLElement;
}

const MOUSE_DRAG_THRESHOLD = 5;
const TOUCH_SCROLL_THRESHOLD = 10;
const TOUCH_HOLD_MS = 300;

function machineGroupReference(element: Element | null): MachineGroupReference | null {
  const group = element?.closest<HTMLElement>(".machine-group");
  const list = group?.closest("#session-list, #sidebar-session-list");
  const surface = group?.dataset.machineSurface;
  if (!group || !list || (surface !== "main" && surface !== "sidebar")) return null;
  return {
    machine: group.dataset.machine ?? "",
    surface,
    name: group.querySelector(".machine-header-name")?.textContent ?? "machine",
  };
}

function groupForReference(reference: MachineGroupReference): HTMLElement | null {
  const list = reference.surface === "main"
    ? document.getElementById("session-list")
    : document.getElementById("sidebar-session-list");
  return Array.from(list?.querySelectorAll<HTMLElement>(".machine-group") ?? [])
    .find(group => group.dataset.machine === reference.machine) ?? null;
}

function touchById(touches: TouchList, identifier: number): Touch | null {
  return Array.from(touches).find(touch => touch.identifier === identifier) ?? null;
}

export interface MachineGroupEventController {
  cancel(): void;
  cancelForRender(): void;
}

class MachineGroupDragController implements MachineGroupEventController {
  private candidate: {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly group: HTMLElement;
    readonly moving: MachineGroupReference;
    readonly originX: number;
    readonly originY: number;
    timer: number | null;
  } | null = null;
  private drag: MachineGroupDragState | null = null;
  private options: MachineGroupMoveOptions | null = null;
  private ignoreNextMenuClick = false;

  public constructor(private readonly handlers: MachineGroupUiHandlers) {}

  public begin(
    target: EventTarget | null,
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void {
    if (!(target instanceof Element) || !target.closest(".machine-name-handle")) return;
    const group = target.closest<HTMLElement>(".machine-group");
    const moving = machineGroupReference(group);
    if (!group || !moving) return;
    this.clearCandidate();
    this.candidate = { pointerId, pointerType, group, moving, originX: clientX, originY: clientY, timer: null };
    if (pointerType !== "mouse") {
      const pending = this.candidate;
      pending.timer = window.setTimeout(() => this.start(pending, pending.originX, pending.originY), TOUCH_HOLD_MS);
    }
  }

  public move(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.drag?.pointerId === pointerId) {
      this.preview(clientX, clientY);
      return true;
    }
    const pending = this.candidate;
    if (!pending || pending.pointerId !== pointerId) return false;
    const distance = Math.hypot(clientX - pending.originX, clientY - pending.originY);
    if (pending.pointerType === "mouse" && distance >= MOUSE_DRAG_THRESHOLD) {
      this.start(pending, clientX, clientY);
      this.preview(clientX, clientY);
      return true;
    }
    if (pending.pointerType !== "mouse" && distance >= TOUCH_SCROLL_THRESHOLD) this.clearCandidate();
    return false;
  }

  public finish(pointerId: number, commit: boolean): void {
    if (this.drag?.pointerId === pointerId) this.finishDrag(commit);
    else if (this.candidate?.pointerId === pointerId) this.clearCandidate();
  }

  public beginTouch(touches: TouchList, target: EventTarget | null): void {
    if (touches.length !== 1) {
      this.clearCandidate();
      return;
    }
    const touch = touches[0];
    this.begin(target, touch.identifier, "touch", touch.clientX, touch.clientY);
  }

  public dragTouch(touches: TouchList): Touch | null {
    return this.drag?.pointerType === "touch" ? touchById(touches, this.drag.pointerId) : null;
  }

  public moveTouchCandidate(touches: TouchList): void {
    const pending = this.candidate;
    if (!pending || pending.pointerType !== "touch") return;
    const touch = touchById(touches, pending.pointerId);
    if (!touch) return;
    if (Math.hypot(touch.clientX - pending.originX, touch.clientY - pending.originY) >= TOUCH_SCROLL_THRESHOLD) {
      this.clearCandidate();
    }
  }

  public matchesTouch(changedTouches: TouchList): boolean {
    const identifier = this.drag?.pointerType === "touch"
      ? this.drag.pointerId
      : this.candidate?.pointerType === "touch"
        ? this.candidate.pointerId
        : undefined;
    return identifier !== undefined && touchById(changedTouches, identifier) !== null;
  }

  public cancel(): void {
    this.finishDrag(false);
    this.closeMenu(false);
  }

  public cancelForRender(): void {
    const restore = this.options?.options.contains(document.activeElement)
      ? machineGroupReference(this.options.button)
      : null;
    this.cancel();
    if (!restore) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      groupForReference(restore)?.querySelector<HTMLElement>(".machine-name-handle")?.focus({ preventScroll: true });
    }));
  }

  public escape(): boolean {
    if (this.closeMenu(true)) return true;
    this.finishDrag(false);
    return false;
  }

  public click(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const menuItem = target.closest<HTMLButtonElement>("[data-machine-menu-offset]");
    if (menuItem) {
      const moving = machineGroupReference(menuItem);
      const offset = menuItem.dataset.machineMenuOffset === "-1" ? -1 : 1;
      const moved = moving ? this.handlers.moveByOffset(moving, offset) : false;
      if (!moved) this.closeMenu(true);
      return;
    }
    const button = target.closest<HTMLButtonElement>(".machine-name-handle");
    if (button) {
      if (this.ignoreNextMenuClick) {
        this.ignoreNextMenuClick = false;
        return;
      }
      this.toggleMenu(button);
      return;
    }
    this.closeMenu(false);
  }

  public focus(target: EventTarget | null): void {
    if (!(target instanceof Node) || !this.options) return;
    if (this.options.button.contains(target) || this.options.options.contains(target)) return;
    this.closeMenu(false);
  }

  public clearCandidate(): void {
    if (this.candidate?.timer !== null && this.candidate?.timer !== undefined) window.clearTimeout(this.candidate.timer);
    this.candidate = null;
  }

  private toggleMenu(button: HTMLButtonElement): void {
    const group = button.closest<HTMLElement>(".machine-group");
    const options = group?.querySelector<HTMLElement>(".machine-order-options");
    if (!options) return;
    if (this.options?.button === button) {
      this.closeMenu(true);
      return;
    }
    this.closeMenu(false);
    this.options = { button, options };
    options.hidden = false;
    options.removeAttribute("inert");
    button.setAttribute("aria-expanded", "true");
    options.querySelector<HTMLButtonElement>("[data-machine-menu-offset]")?.focus({ preventScroll: true });
  }

  private closeMenu(returnFocus: boolean): boolean {
    const active = this.options;
    this.options = null;
    if (!active) return false;
    if (active.options.isConnected) {
      active.options.hidden = true;
      active.options.setAttribute("inert", "");
    }
    if (active.button.isConnected) active.button.setAttribute("aria-expanded", "false");
    if (returnFocus && active.button.isConnected) active.button.focus({ preventScroll: true });
    return true;
  }

  private start(
    pending: NonNullable<MachineGroupDragController["candidate"]>,
    clientX: number,
    clientY: number,
  ): void {
    if (this.candidate !== pending || this.drag) return;
    this.closeMenu(false);
    this.clearCandidate();
    const originParent = pending.group.parentElement;
    if (!originParent) return;
    const rect = pending.group.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "machine-group-order-placeholder";
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;
    placeholder.setAttribute("aria-hidden", "true");
    const originNextSibling = pending.group.nextSibling;
    originParent.insertBefore(placeholder, pending.group);
    const originalStyle = pending.group.style.cssText;
    pending.group.classList.add("machine-group-drag-floating");
    pending.group.style.left = `${rect.left}px`;
    pending.group.style.top = `${rect.top}px`;
    pending.group.style.width = `${rect.width}px`;
    pending.group.style.height = `${rect.height}px`;
    document.body.appendChild(pending.group);
    this.drag = {
      pointerId: pending.pointerId,
      pointerType: pending.pointerType,
      group: pending.group,
      moving: pending.moving,
      originalStyle,
      originParent,
      originNextSibling,
      placeholder,
      pointerOffsetX: clientX - rect.left,
      pointerOffsetY: clientY - rect.top,
      target: null,
      placement: "before",
    };
    this.handlers.setDragActive(true);
    try { pending.group.setPointerCapture(pending.pointerId); } catch { /* synthetic pointer events */ }
  }

  private clearPreview(active: MachineGroupDragState): void {
    if (!active.target) return;
    active.originParent.insertBefore(active.placeholder, active.originNextSibling);
    active.target = null;
  }

  public preview(clientX: number, clientY: number): void {
    const active = this.drag;
    if (!active) return;
    active.group.style.left = `${clientX - active.pointerOffsetX}px`;
    active.group.style.top = `${clientY - active.pointerOffsetY}px`;
    const point = document.elementFromPoint(clientX, clientY);
    // The preview placeholder occupies the intended insertion slot. Keeping the
    // existing target while crossing it preserves a valid drop; points outside
    // that slot still clear the target below.
    if (point?.closest(".machine-group-order-placeholder")) return;
    const target = machineGroupReference(point);
    if (!target || target.surface !== active.moving.surface || target.machine === active.moving.machine) {
      this.clearPreview(active);
      return;
    }
    const targetGroup = groupForReference(target);
    if (!targetGroup) {
      this.clearPreview(active);
      return;
    }
    const rect = targetGroup.getBoundingClientRect();
    const placement = clientY > rect.top + rect.height / 2 ? "after" : "before";
    if (active.target?.machine === target.machine && active.placement === placement) return;
    active.originParent.insertBefore(active.placeholder, placement === "before" ? targetGroup : targetGroup.nextSibling);
    active.target = target;
    active.placement = placement;
  }

  private finishDrag(commit: boolean): void {
    const active = this.drag;
    this.drag = null;
    this.clearCandidate();
    if (!active) return;
    if (active.pointerType !== "touch") {
      this.ignoreNextMenuClick = true;
      window.setTimeout(() => { this.ignoreNextMenuClick = false; }, 0);
    }
    active.group.classList.remove("machine-group-drag-floating");
    active.group.style.cssText = active.originalStyle;
    active.originParent.insertBefore(active.group, active.originNextSibling);
    active.placeholder.remove();
    this.handlers.setDragActive(false);
    if (commit && active.target) this.handlers.move(active.moving, active.target, active.placement);
  }
}

export function bindMachineGroupEvents(handlers: MachineGroupUiHandlers): MachineGroupEventController {
  const drag = new MachineGroupDragController(handlers);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (drag.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".machine-name-handle") || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const moving = machineGroupReference(target);
    if (!moving || !handlers.moveByOffset(moving, event.key === "ArrowUp" ? -1 : 1)) return;
    event.preventDefault();
    event.stopPropagation();
    requestAnimationFrame(() => groupForReference(moving)?.querySelector<HTMLElement>(".machine-name-handle")?.focus());
  });
  document.addEventListener("click", event => drag.click(event.target));
  document.addEventListener("focusin", event => drag.focus(event.target));
  document.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.begin(event.target, event.pointerId, event.pointerType, event.clientX, event.clientY);
  });
  document.addEventListener("pointermove", event => {
    if (event.pointerType === "touch" || !drag.move(event.pointerId, event.clientX, event.clientY)) return;
    event.preventDefault();
  }, { passive: false });
  // The dragged group moves under document.body and captures the pointer; capture
  // phase keeps finalization observable even when the browser retargets pointerup.
  const finishPointer = (event: PointerEvent, commit: boolean) => {
    if (event.pointerType !== "touch") drag.finish(event.pointerId, commit);
  };
  document.addEventListener("pointerup", event => finishPointer(event, true), true);
  document.addEventListener("pointercancel", event => finishPointer(event, false), true);
  document.addEventListener("lostpointercapture", event => finishPointer(event, false), true);
  document.addEventListener("touchstart", event => {
    drag.beginTouch(event.touches, event.target);
  }, { passive: true });
  document.addEventListener("touchmove", event => {
    const touch = drag.dragTouch(event.touches);
    if (touch) {
      event.preventDefault();
      drag.preview(touch.clientX, touch.clientY);
      return;
    }
    drag.moveTouchCandidate(event.touches);
  }, { passive: false });
  document.addEventListener("touchend", event => {
    if (!drag.matchesTouch(event.changedTouches)) return;
    const touch = drag.dragTouch(event.changedTouches);
    if (touch) {
      event.preventDefault();
      drag.finish(touch.identifier, true);
    } else {
      drag.clearCandidate();
    }
  }, { passive: false });
  document.addEventListener("touchcancel", event => {
    if (!drag.matchesTouch(event.changedTouches)) return;
    const touch = drag.dragTouch(event.changedTouches);
    if (touch) drag.finish(touch.identifier, false);
    else drag.clearCandidate();
  });
  window.addEventListener("blur", () => drag.cancel());
  return drag;
}
