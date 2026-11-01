import { isSessionOrganization, normalizeOrganizationUpdate } from "../src/session-organization-contract";
import type { SessionOrganization, SessionOrganizationUpdate } from "../src/session-organization-contract";

export interface OrganizationEditorOptions {
  readonly session: string;
  readonly initial: SessionOrganization;
  readonly suggestions: readonly SessionOrganization[];
  readonly isCurrent: () => boolean;
  readonly read: (signal: AbortSignal) => Promise<SessionOrganization>;
  readonly save: (update: SessionOrganizationUpdate, signal: AbortSignal) => Promise<SessionOrganization>;
  readonly saved: (value: SessionOrganization) => void;
  readonly returnFocus: () => void;
}

/** Pin the exact action and chooser, including the dashboard's Needs you duplicate. */
export function captureOrganizationFocus(invoker: Element | null): (() => void) | undefined {
  if (!(invoker instanceof HTMLButtonElement) || !invoker.matches('[data-action="organize-session"]')) return;
  const chooser = invoker.closest<HTMLElement>('#session-list, #sidebar-session-list, #drawer-list');
  const { sessionId, machine } = invoker.dataset;
  if (!chooser || sessionId === undefined || machine === undefined) return;
  const action = invoker.classList.contains("organization-more") ? ".organization-more" : ".organize-btn";
  const pinned = Boolean(invoker.closest(".needs-you"));
  const selector = `${action}[data-session-id="${CSS.escape(sessionId)}"][data-machine="${CSS.escape(machine)}"]`;
  return () => {
    const target = invoker.isConnected ? invoker : [...chooser.querySelectorAll<HTMLButtonElement>(selector)]
      .find(candidate => Boolean(candidate.closest(".needs-you")) === pinned);
    // A removed/hidden owner is not permission to focus another session surface.
    if (target && chooser.isConnected && !target.disabled && !target.closest('[inert], [hidden]')
      && target.getClientRects().length && getComputedStyle(target).visibility === "visible") target.focus({ preventScroll: true });
  };
}

let active: HTMLDialogElement | null = null;
/** Native modal, matching app-dialog focus/cancel conventions. Drafts live until explicit close. */
export function showOrganizationEditor(options: OrganizationEditorOptions): void {
  if (active?.open || document.querySelector("dialog[open]")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog organization-dialog";
  dialog.setAttribute("aria-labelledby", "organization-title");
  dialog.innerHTML = `<form>
    <h2 id="organization-title"></h2>
    <p>Labels only — session order and parent relationships stay unchanged.</p>
    <label class="app-dialog-field">Group<input name="group" list="organization-groups" autocomplete="off"></label>
    <button type="button" class="organization-secondary" data-editor="clear">Clear group</button>
    <datalist id="organization-groups"></datalist>
    <div class="organization-tags" aria-label="Tags"></div>
    <div class="organization-add-row"><label class="app-dialog-field">New tag<input name="tag" list="organization-suggestions" autocomplete="off"></label><button type="button" class="organization-secondary" data-editor="add">Add tag</button></div>
    <datalist id="organization-suggestions"></datalist>
    <p class="organization-help">Up to 16 tags. Each label: 64 characters, no control characters.</p>
    <p class="organization-error" role="alert"></p>
    <p class="organization-status" role="status" aria-live="polite"></p>
    <div class="organization-review" hidden><button type="button" class="organization-secondary" data-editor="review">Review latest</button><button type="button" class="organization-secondary" data-editor="use" hidden>Use latest</button></div>
    <div class="app-dialog-actions"><button type="button" data-editor="cancel">Cancel</button><button type="submit" class="organization-save">Save</button></div>
  </form>`;
  dialog.querySelector("h2")!.textContent = `Organize ${options.session}`;
  const form = dialog.querySelector("form")!;
  const group = dialog.querySelector<HTMLInputElement>('[name="group"]')!;
  const tag = dialog.querySelector<HTMLInputElement>('[name="tag"]')!;
  const tagsElement = dialog.querySelector<HTMLElement>(".organization-tags")!;
  const error = dialog.querySelector<HTMLElement>(".organization-error")!;
  const status = dialog.querySelector<HTMLElement>(".organization-status")!;
  const reviewArea = dialog.querySelector<HTMLElement>(".organization-review")!;
  const useLatest = dialog.querySelector<HTMLButtonElement>('[data-editor="use"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const controller = new AbortController();
  let revision = options.initial.revision;
  let tags = [...options.initial.tags];
  let pending = false;
  let needsReview = false;
  let latest: SessionOrganization | null = null;
  group.value = options.initial.group ?? "";
  for (const [selector, values] of [
    ["#organization-groups", options.suggestions.flatMap(value => value.group ? [value.group] : [])],
    ["#organization-suggestions", options.suggestions.flatMap(value => [...value.tags])],
  ] as const) {
    for (const value of new Set(values)) { const option = document.createElement("option"); option.value = value; dialog.querySelector(selector)!.append(option); }
  }
  function scopeCurrent(): boolean { return active === dialog && dialog.open && !controller.signal.aborted && options.isCurrent(); }
  function syncDisabled(): void {
    const current = scopeCurrent();
    save.disabled = pending || needsReview || !current;
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, .organization-secondary')) control.disabled = pending || !current;
    if (!current && dialog.open) error.textContent = "This session or machine is no longer available. Your draft is retained; cancel and reopen on a ready machine.";
    form.setAttribute("aria-busy", String(pending));
  }
  function renderTags(): void {
    tagsElement.replaceChildren();
    for (const [index, value] of tags.entries()) {
      const chip = document.createElement("span"); chip.className = "organization-tag";
      const text = document.createElement("span"); text.textContent = value;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove tag ${value}`);
      remove.addEventListener("click", () => { if (pending || !scopeCurrent()) return; tags.splice(index, 1); renderTags(); tag.focus(); });
      chip.append(text, remove); tagsElement.append(chip);
    }
  }
  function addTag(): boolean {
    if (!tag.value) return true;
    try {
      tags = [...normalizeOrganizationUpdate({ expectedRevision: revision, tags: [...tags, tag.value] }).tags!];
      tag.value = ""; error.textContent = ""; renderTags(); tag.focus(); return true;
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Invalid tag"; return false; }
  }
  function failureMessage(failure: unknown): void {
    const response = failure as { status?: number; data?: { code?: string } };
    if (response.status === 409) {
      error.textContent = "Labels changed elsewhere. Your draft is retained. Review latest before saving.";
      needsReview = true;
    } else if (response.status === 404 && response.data?.code !== "SESSION_NOT_FOUND") {
      error.textContent = "This host does not support session organization. Your draft is retained.";
      needsReview = true;
    } else {
      error.textContent = "Could not save labels. Your draft is retained; read the latest saved values before retrying an uncertain save.";
      needsReview = true;
    }
    reviewArea.hidden = false;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending || needsReview || !scopeCurrent() || !addTag()) return;
    let update: SessionOrganizationUpdate;
    try { update = normalizeOrganizationUpdate({ expectedRevision: revision, group: group.value.trim() ? group.value : null, tags }); }
    catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Invalid labels"; return; }
    pending = true; error.textContent = ""; status.textContent = "Saving…"; syncDisabled();
    try {
      const canonical = await options.save(update, controller.signal);
      if (!scopeCurrent()) return;
      if (!isSessionOrganization(canonical)) throw new Error("invalid save response");
      options.saved(canonical);
      dialog.close();
    } catch (failure) { if (scopeCurrent()) failureMessage(failure); }
    finally { pending = false; status.textContent = ""; syncDisabled(); }
  });
  dialog.querySelector('[data-editor="review"]')!.addEventListener("click", async () => {
    if (pending || !scopeCurrent()) return;
    pending = true; syncDisabled(); status.textContent = "Reading latest saved labels…";
    try {
      const value = await options.read(controller.signal);
      if (!scopeCurrent()) return;
      if (!isSessionOrganization(value)) throw new Error("invalid read response");
      latest = value;
      status.textContent = `Latest saved — group: ${value.group ?? "none"}; tags: ${value.tags.join(", ") || "none"}. Your draft has not changed.`;
      useLatest.hidden = false;
    } catch { if (scopeCurrent()) status.textContent = "Could not read saved labels. Your draft has not changed."; }
    finally { pending = false; syncDisabled(); }
  });
  useLatest.addEventListener("click", () => {
    if (!latest || pending || !scopeCurrent()) return;
    group.value = latest.group ?? ""; tags = [...latest.tags]; tag.value = ""; revision = latest.revision;
    needsReview = false; error.textContent = ""; status.textContent = "Latest saved labels loaded. Review and edit before saving.";
    reviewArea.hidden = true; renderTags(); syncDisabled(); group.focus();
  });
  dialog.querySelector('[data-editor="clear"]')!.addEventListener("click", () => { group.value = ""; group.focus(); });
  dialog.querySelector('[data-editor="add"]')!.addEventListener("click", addTag);
  tag.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addTag(); } });
  dialog.querySelector('[data-editor="cancel"]')!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  const timer = setInterval(syncDisabled, 500);
  dialog.addEventListener("close", () => {
    clearInterval(timer); controller.abort();
    if (active === dialog) active = null;
    dialog.remove(); options.returnFocus();
  }, { once: true });
  renderTags(); document.body.append(dialog); active = dialog; dialog.showModal(); syncDisabled(); group.focus();
}
