import { normalizeOrganizationUpdate } from "../src/session-organization-contract";
import { sessionGroupLabel } from "./session-grouping";
import type { SessionOrganization, SessionOrganizationUpdate } from "../src/session-organization-contract";

export interface OrganizationEditorOptions {
  readonly session: string;
  readonly tree?: string;
  readonly initial: SessionOrganization;
  readonly groups: readonly string[];
  readonly destination?: string | null;
  readonly isCurrent: () => boolean;
  /** The owning request path validates canonical metadata and the pinned response UUID. */
  readonly read: (signal: AbortSignal) => Promise<SessionOrganization>;
  readonly save: (update: SessionOrganizationUpdate, signal: AbortSignal) => Promise<SessionOrganization>;
  readonly saved: (value: SessionOrganization) => void;
  readonly returnFocus: () => void;
}

/** Pin the exact action and chooser, including the dashboard's Needs you duplicate. */
export function captureOrganizationFocus(invoker: Element | null): (() => void) | undefined {
  if (!(invoker instanceof HTMLButtonElement) || !invoker.matches('[data-action="organize-session"], .session-group-toggle')) return;
  const chooser = invoker.closest<HTMLElement>('#session-list, #sidebar-session-list, #drawer-list');
  if (!chooser) return;
  const { sessionId, machine, groupKey } = invoker.dataset;
  const selector = groupKey !== undefined ? `.session-group-toggle[data-group-key="${CSS.escape(groupKey)}"]`
    : `.organize-btn[data-session-id="${CSS.escape(sessionId ?? "")}"][data-machine="${CSS.escape(machine ?? "")}"]`;
  const pinned = Boolean(invoker.closest(".needs-you"));
  return () => {
    if (document.querySelector("dialog[open]")) return;
    let target = invoker.isConnected ? invoker : [...chooser.querySelectorAll<HTMLButtonElement>(selector)]
      .find(candidate => Boolean(candidate.closest(".needs-you")) === pinned);
    // A still-owned action may move under a collapsed group during an external refresh.
    if (target && !target.disabled && target.closest('.session-label-body[hidden]')) {
      target = target.closest('.session-label-group')?.querySelector<HTMLButtonElement>('.session-group-toggle') ?? undefined;
    }
    // A removed/hidden owner is not permission to focus another session surface.
    if (target && chooser.isConnected && chooser.contains(target) && !target.disabled && !target.closest('[inert], [hidden]')
      && target.getClientRects().length && getComputedStyle(target).visibility === "visible") target.focus({ preventScroll: true });
  };
}

let active: HTMLDialogElement | null = null;
/** Native modal, matching app-dialog focus/cancel conventions. Drafts live until explicit close. */
export function showOrganizationEditor(options: OrganizationEditorOptions): void {
  if (document.querySelector("dialog[open]")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog organization-dialog";
  dialog.setAttribute("aria-labelledby", "organization-title");
  dialog.innerHTML = `<form>
    <h2 id="organization-title"></h2>
    <p></p>
    <div class="app-dialog-field"><label for="organization-destination">Move to group</label><select id="organization-destination" name="destination"></select></div>
    <label class="app-dialog-field">Group<input name="group" autocomplete="off"></label>
    <p class="organization-error" role="alert"></p>
    <p class="organization-status" role="status"></p>
    <div class="organization-review" hidden><button type="button" class="organization-secondary" data-editor="review">Review latest</button><button type="button" class="organization-secondary" data-editor="use" hidden>Use latest</button></div>
    <div class="app-dialog-actions"><button type="button" data-editor="cancel">Cancel</button><button type="submit" class="organization-save">Move</button></div>
  </form>`;
  dialog.querySelector("h2")!.textContent = `Move ${options.session} to group`;
  dialog.querySelector("p")!.textContent = options.tree
    ? `Moves the whole ${options.tree} tree, including all child agents.` : "";
  const form = dialog.querySelector("form")!;
  const group = dialog.querySelector<HTMLInputElement>('[name="group"]')!;
  const field = group.parentElement!;
  const destination = dialog.querySelector<HTMLSelectElement>('[name="destination"]')!;
  const error = dialog.querySelector<HTMLElement>(".organization-error")!;
  const status = dialog.querySelector<HTMLElement>(".organization-status")!;
  const reviewArea = dialog.querySelector<HTMLElement>(".organization-review")!;
  const useLatest = dialog.querySelector<HTMLButtonElement>('[data-editor="use"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const controller = new AbortController();
  let revision = options.initial.revision;
  let savedGroup = options.initial.group;
  let pending = false;
  let needsReview = false;
  let latest: SessionOrganization | null = null;
  const values: (string | null)[] = [null, ...[...new Set(options.groups)].sort()];
  values.forEach((value, index) => destination.add(new Option(sessionGroupLabel(value), String(index))));
  destination.add(new Option("New group…", "new"));
  function setGroup(value: string | null | undefined): void {
    group.value = value ?? "";
    const index = value === undefined ? -1 : values.indexOf(value);
    destination.value = index < 0 ? "new" : String(index);
    field.hidden = index >= 0;
    if (index < 0) group.focus();
  }
  setGroup(options.destination === undefined ? options.initial.group : options.destination);
  function scopeCurrent(): boolean { return active === dialog && dialog.open && !controller.signal.aborted && options.isCurrent(); }
  function syncDisabled(): void {
    const current = scopeCurrent();
    save.disabled = pending || needsReview || !current;
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, select, .organization-secondary')) control.disabled = pending || !current;
    if (!current && dialog.open) error.textContent = "Session or machine no longer available. Cancel and reopen when ready.";
    form.setAttribute("aria-busy", String(pending));
  }
  function failureMessage(failure: unknown): void {
    const response = failure as { status?: number; data?: { code?: string } };
    if (response.status === 409) {
      error.textContent = "Group changed elsewhere. Draft retained; review latest.";
    } else if (response.status === 404 && response.data?.code !== "SESSION_NOT_FOUND") {
      error.textContent = "Grouping unsupported on this host. Draft retained.";
    } else {
      error.textContent = "Move failed or uncertain; read latest before retrying. Draft retained.";
    }
    needsReview = true; reviewArea.hidden = false;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending || needsReview || !scopeCurrent()) return;
    let update: SessionOrganizationUpdate;
    try { update = normalizeOrganizationUpdate({ expectedRevision: revision, group: destination.value === "0" ? null : group.value }); }
    catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Invalid group"; return; }
    if (update.group === savedGroup) { dialog.close(); return; }
    pending = true; error.textContent = ""; status.textContent = "Moving…"; syncDisabled();
    try {
      const canonical = await options.save(update, controller.signal);
      if (!scopeCurrent()) return;
      options.saved(canonical);
      dialog.close();
    } catch (failure) { if (scopeCurrent()) failureMessage(failure); }
    finally { pending = false; status.textContent = ""; syncDisabled(); }
  });
  dialog.querySelector('[data-editor="review"]')!.addEventListener("click", async () => {
    if (pending || !scopeCurrent()) return;
    pending = true; syncDisabled(); status.textContent = "Reading latest…";
    try {
      const value = await options.read(controller.signal);
      if (!scopeCurrent()) return;
      latest = value;
      status.textContent = `Latest saved — ${sessionGroupLabel(value.group)}. Your draft has not changed.`;
      useLatest.hidden = false;
    } catch { if (scopeCurrent()) status.textContent = "Could not read latest. Draft unchanged."; }
    finally { pending = false; syncDisabled(); }
  });
  useLatest.addEventListener("click", () => {
    if (!latest || pending || !scopeCurrent()) return;
    setGroup(latest.group); revision = latest.revision; savedGroup = latest.group;
    needsReview = false; error.textContent = ""; status.textContent = "Latest loaded. Review before moving.";
    reviewArea.hidden = true; syncDisabled(); destination.focus();
  });
  destination.addEventListener("change", () => setGroup(values[Number(destination.value)]));
  dialog.querySelector('[data-editor="cancel"]')!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  const timer = setInterval(syncDisabled, 500);
  dialog.addEventListener("close", () => {
    clearInterval(timer); controller.abort();
    if (active === dialog) active = null;
    dialog.remove(); options.returnFocus();
  }, { once: true });
  document.body.append(dialog); active = dialog; dialog.showModal(); syncDisabled(); destination.focus();
  if (options.destination !== undefined) form.requestSubmit();
}
