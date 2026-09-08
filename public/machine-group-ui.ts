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

export interface MachineGroupEventController {
  cancel(): void;
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

  public constructor(private readonly handlers: MachineGroupUiHandlers) {}

  public begin(
    target: EventTarget | null,
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void {
    if (!(target instanceof Element) || !target.closest(".machine-order-handle")) return;
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

  public cancel(): void {
    this.finishDrag(false);
  }

  private clearCandidate(): void {
    if (this.candidate?.timer !== null && this.candidate?.timer !== undefined) window.clearTimeout(this.candidate.timer);
    this.candidate = null;
  }

  private start(
    pending: NonNullable<MachineGroupDragController["candidate"]>,
    clientX: number,
    clientY: number,
  ): void {
    if (this.candidate !== pending || this.drag) return;
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

  private preview(clientX: number, clientY: number): void {
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
      drag.cancel();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".machine-order-handle") || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const moving = machineGroupReference(target);
    if (!moving || !handlers.moveByOffset(moving, event.key === "ArrowUp" ? -1 : 1)) return;
    event.preventDefault();
    event.stopPropagation();
    requestAnimationFrame(() => groupForReference(moving)?.querySelector<HTMLElement>(".machine-order-handle")?.focus());
  });
  document.addEventListener("pointerdown", event => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.begin(event.target, event.pointerId, event.pointerType, event.clientX, event.clientY);
  });
  document.addEventListener("pointermove", event => {
    if (!drag.move(event.pointerId, event.clientX, event.clientY)) return;
    event.preventDefault();
  }, { passive: false });
  // The dragged group moves under document.body and captures the pointer; capture
  // phase keeps finalization observable even when the browser retargets pointerup.
  document.addEventListener("pointerup", event => drag.finish(event.pointerId, true), true);
  document.addEventListener("pointercancel", event => drag.finish(event.pointerId, false), true);
  document.addEventListener("lostpointercapture", event => drag.finish(event.pointerId, false), true);
  window.addEventListener("blur", () => drag.cancel());
  return drag;
}
