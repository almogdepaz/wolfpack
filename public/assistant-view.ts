import { linkStartedFocusSession, type FocusSessionStart, type StartedFocusSession } from "../src/focus-start";
import { esc, escAttr, isDesktop } from "./app-state";
import { focusCards, mergeFocus, takeVisible, stoppedUnseen, linkedFocusSessions, doneToday, groupFocusDone, type FocusDoneGroup, focusSessionLabel, focusActionVerb, type FocusAction, type FocusSession } from "../src/focus-ranking";
import { emptyFocus, isFocusDocument, focusNextRefKey, type FocusDocument, type FocusIntention, type FocusOp } from "../src/focus-contract";
import type { AssistantTiming } from "../src/focus-scheduler";
import { SESSION_SEND_OUTCOME, type SessionSendOutcome } from "../src/session-send-contract";
import { focusLastLine } from "../src/focus-text";
import { createFocusReceipts, focusSuggestionKey, focusReplyKey, FOCUS_REPLY_MAX_LENGTH, type FocusSendReceipt } from "./focus-receipts";
import type { AssistantTerminalTarget } from "./assistant-terminal";
import { createDayNoteContent } from "./focus-day-note";
import { showAppDialog } from "./app-dialog";
import { createFocusMobileDisclosure, FOCUS_DESKTOP_EXPANDED_KEY } from "./focus-mobile-disclosure";
import { isRequestTimeout } from "./fetch-timeout";
import { isFocusHomeIdentity, type FocusHomeIdentity } from "../src/focus-home-contract";
import { AGENT_CONTEXT_DOCUMENT_PATH, agentContextEnabled, extensionUnavailable, summarizeAgentContext } from "../src/focus-context";
interface AssistantStatus { enabled: boolean; folder: string; state: string; session?: string; sessionId?: string; queued: number; error?: string; unavailableReason?: string }
interface RoutineStatus { catchingUp: { machines: number; since: string | null; unconfirmed?: true } | null; yesterday?: { date: string; note: boolean; endsAt: string }; stale: { since: string } | null; unreachable: { name: string; since: string | null }[]; surfaced: { sends: number } | null; notice?: string; error?: string }
interface FocusResponse extends FocusHomeIdentity { document: FocusDocument | null; revision: number; assistant?: AssistantStatus; routines?: RoutineStatus; nextOrderTtlHours?: number }
interface Machine { key: string; name: string }
class FocusOwnershipError extends Error {}
const HOME_CHANGED = "not saved — the home changed; review the current home and try again.";
const OLD_HOME_COMPLETED = "the home changed; this request completed on the previous home. Check it before retrying.";
const OLD_HOME_DELIVERY = "the home changed; check the previous session's delivery before retrying.";
class FocusHomeChanged extends FocusOwnershipError { constructor(message = HOME_CHANGED) { super(message); } }
interface HomeOwner { readonly home: string; readonly generation: number; readonly machine: string; readonly name: string }
const isTransportFailure = (error: unknown) => !(error instanceof FocusOwnershipError)
  && (error instanceof TypeError || isRequestTimeout(error) || navigator.onLine === false);
export function createAssistantView(deps: {
  request: <T>(path: string, init?: RequestInit, machine?: string, interactive?: boolean) => Promise<T>;
  homeMachine: (id: string) => Machine | undefined;
  homeMachines: () => { id: string; name: string; online: boolean }[];
  localMachineName: () => string;
  machineReachable: (installationId: string) => boolean;
  sessions: () => FocusSession[];
  /** Verify a cached assistant incarnation against the current owning session list. */
  terminalSessionAvailable: (target: AssistantTerminalTarget) => boolean;
  terminalTarget: (target: AssistantTerminalTarget | null, unavailableMessage?: string) => void;
  expandTerminal: () => boolean;
  /** False means the local session projection is unavailable, not that every session stopped. */
  sessionsAvailable: () => boolean;
  /** A completed local session fetch failed; the initial pending fetch is not an outage. */
  sessionsUnavailable: () => boolean;
  /** Unavailable peers may retain history; retired/replaced installations may not. */
  sessionMachineKnown: (identity: string) => boolean;
  open: (name: string, machine?: string) => void;
  acknowledge: (session: FocusSession) => Promise<void>;
  start: (intention: FocusIntention) => void;
  show: (view: string) => void;
  confirm: (enabled: boolean) => Promise<boolean>;
}) {
  let focus: FocusResponse | undefined;
  let localOwner: FocusHomeIdentity | undefined;
  let homeGeneration = 0;
  let homeChanging = false;
  let timingOwner: HomeOwner | undefined;
  let timingSave: HomeOwner | undefined;
  let timingLoad = 0;
  const startOwners = new WeakMap<FocusSessionStart, HomeOwner>();
  let machine = "";
  let localInstallationId = "";
  let homeName = "sgt";
  let focusUnavailable = false;
  // A later store fault cannot revive an explicitly rejected owner.
  let terminalOwner: "eligible" | "rejected" = "eligible";
  // No answer from the home yet (first paint from the cache): show the cached copy as it was, write nothing.
  let answered = false;
  // Saved writes; a poll started before one does not replace the document it saved.
  let writes = 0;
  let error = "";
  let transportFailure = false;
  const offline = () => focusUnavailable && transportFailure;
  let notice = "";
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const NOTICE_MS = 5_000;
  function announce(text: string) {
    clearTimeout(noticeTimer);
    notice = text;
    noticeTimer = setTimeout(() => { notice = ""; render(); }, NOTICE_MS);
  }
  let flight: Promise<void> | undefined;
  let busy = false;
  let opened = false;
  let showAllNext = false;
  const mobileDisclosure = createFocusMobileDisclosure();
  const desktopDisclosure = createFocusMobileDisclosure(undefined, { key: FOCUS_DESKTOP_EXPANDED_KEY, defaultExpanded: true });
  const dashboardDisclosure = () => isDesktop() ? desktopDisclosure : mobileDisclosure;
  let dashboardAttention = false;
  const pageNextCap = () => showAllNext ? Infinity : 5;
  let wasEnabled = false;
  let sidebarOwnsChooser = false;
  function updateSidebarVisibility() {
    const tile = document.getElementById("sidebar-assistant");
    if (tile) tile.hidden = !sidebarOwnsChooser || !focus?.assistant?.enabled;
  }
  const cacheKey = "wolfpack-focus-cache";
  try { const cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && (cached.document === null || isFocusDocument(cached.document))) { focus = cached; if (cached.terminalOwner === "rejected") terminalOwner = "rejected"; if (typeof cached.machine === "string") machine = cached.machine; if (typeof cached.homeName === "string") homeName = cached.homeName; } } catch { /* no valid cached focus */ }
  const ownerIsCurrent = (owner: Pick<HomeOwner, "home" | "generation">) => owner.home === localOwner?.home && owner.generation === homeGeneration;
  function requireOwner(owner: HomeOwner, message = HOME_CHANGED) { if (!ownerIsCurrent(owner)) throw new FocusHomeChanged(message); }
  function captureOwner(): HomeOwner {
    if (!localOwner || !answered || focusUnavailable || focus?.home !== localOwner.home) throw new Error("focus is unavailable; changes were not saved");
    const target = localOwner.local ? { key: "", name: "this machine" } : deps.homeMachine(localOwner.home);
    if (!target) throw new TypeError("focus home is offline; changes were not saved");
    return { home: localOwner.home, generation: homeGeneration, machine: target.key, name: target.name };
  }
  function acceptOwner(next: NonNullable<typeof localOwner>): boolean {
    const previous = localOwner?.home ?? focus?.home;
    localOwner = next;
    const changed = previous !== undefined && previous !== next.home;
    if (changed) {
      homeGeneration++;
      timingOwner = undefined; timingSave = undefined; timingLoad++;
      timingForm?.reset(); syncTimingControls();
      terminalOwner = "rejected"; deps.terminalTarget(null);
      try { localStorage.removeItem(cacheKey); } catch { /* storage unavailable */ }
    }
    return changed;
  }
  const terminalUnavailable = () => focus?.assistant?.unavailableReason;
  const locked = () => focusUnavailable || busy || !answered;
  const sessionLocked = () => locked() || !deps.sessionsAvailable();
  function terminalTarget(): AssistantTerminalTarget | null {
    const assistant = focus?.assistant;
    if (!answered || terminalOwner === "rejected" || !assistant?.enabled || !assistant.session || offline() || (!focusUnavailable && terminalUnavailable())) return null;
    // A remote /focus response is local to its own server, not this browser.
    const home = machine || deps.homeMachine(focus!.home)?.key || "";
    if (home && !deps.sessionMachineKnown(home)) return null;
    const target = { session: assistant.session, sessionId: assistant.sessionId, machine: home };
    // A focus-store fault must not disconnect a separately verified live terminal.
    // Cached identity alone cannot authorize a missing/replaced/offline session.
    return !focusUnavailable || deps.terminalSessionAvailable(target) ? target : null;
  }
  // Presentation only: retain the last verified projection during a self-offline poll.
  // All session actions are disabled until the local projection is available again.
  let lastSessions: FocusSession[] = [];
  const sessions = () => {
    const fresh = deps.sessions().map(session => ({ ...session, lastLine: focusLastLine(session.lastLine ?? ""), machineInstallationId: session.machineInstallationId || (!session.machineUrl ? localInstallationId : undefined) }));
    // A failed/pending list is not an authoritative empty list. Preserve its last episode
    // facts, but never retain a retired installation or revive a deleted reachable session.
    const retained = lastSessions.filter(session => session.machineUrl
      ? deps.sessionMachineKnown(session.machineUrl) && !deps.machineReachable(session.machineInstallationId ?? "")
      : !deps.sessionsAvailable());
    lastSessions = [...fresh, ...retained.filter(old => !fresh.some(s => s.id === old.id && s.machineInstallationId === old.machineInstallationId))];
    return lastSessions;
  };
  const nextOrder = (cap: number) => mergeFocus(doc(), sessions(), {
    cap, enabled: !!focus?.assistant?.enabled, stale: !!routines()?.stale,
    ttlHours: focus?.nextOrderTtlHours,
    machineKnown: id => id === localInstallationId || !!deps.homeMachine(id),
    machineReachable: id => id === localInstallationId ? deps.sessionsAvailable() : deps.machineReachable(id),
  });
  const cardOrder = () => {
    const rows = nextOrder(Infinity).rows;
    return focusCards(!deps.sessionsAvailable() && !lastSessions.length ? rows.filter(row => row.source === "assistant") : rows, sessions());
  };
  const nextRows = (cap: number) => cardOrder().cards.slice(0, Math.max(0, cap)).map(card => card.row);
  const orderLabel = () => {
    const order = nextOrder(0);
    return order.order === "assistant" ? `ordered ${age(order.updatedAt!)} ago` : order.order === "expired" ? "by rules · order expired" : "by rules";
  };
  // The cached copy carries the home's resolved name, so an offline first answer names the right machine.
  const cache = (value: FocusResponse) => { try { localStorage.setItem(cacheKey, JSON.stringify({ ...value, homeName, machine, terminalOwner })); } catch { /* storage unavailable; live view still works */ } };
  const doc = () => focus?.document ?? emptyFocus();
  const routines = () => focusUnavailable || terminalUnavailable() || !focus?.assistant?.enabled ? undefined : focus.routines;
  // An error beside a live session (a dropped queue, an unverified send) is a note under the live state; "failed" is the assistant not running.
  const status = () => focusUnavailable ? (offline() ? `${homeName} offline` : "focus unavailable") : terminalUnavailable() ? "unavailable" : focus?.assistant?.error && !focus.assistant.session ? "failed" : focus?.assistant?.enabled ? (focus.assistant.state === "needs-input" ? "needs you" : routines()?.catchingUp ? "catching up" : focus.assistant.state) : "off";
  // Today's times need no weekday; older catching-up / stale / not-reached times keep it.
  const when = (at: string) => new Date(at).toLocaleString([], { weekday: localDay(Date.parse(at)) === localDay(Date.now()) ? undefined : "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const doneDay = (at: string) => localDay(Date.parse(at));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const dayName = (date: string) => date === localDay(Date.now() - 864e5) ? "yesterday" : new Date(`${date}T12:00`).toLocaleDateString([], { weekday: "short" });
  const freshness = () => doc().updatedAt ? `updated ${age(doc().updatedAt!)}` : "set your focus";
  function age(at: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
    return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
  }
  // A routine send whose submission could not be verified: uncertain, not failed.
  const DELIVERY_UNCONFIRMED = "not confirmed yet";
  const button = (action: string, label: string, name = label, disabled = false, key = action) => `<button type="button" data-focus-action="${action}" data-focus-key="${escAttr(`action:${key}`)}" aria-label="${escAttr(name)}"${disabled ? " disabled" : ""}>${esc(label.replace(" ›", ""))}${label.endsWith(" ›") ? '<span aria-hidden="true"> ›</span>' : ""}</button>`;
  // The sidebar tile's mark: a four-point spark (decorative; the tile's label names it).
  const TILE_MARK = '<svg class="assistant-tile-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l1.8 5.7 5.7 1.8-5.7 1.8L12 17.5l-1.8-5.7L4.5 10l5.7-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" opacity=".65"/></svg>';
  const dot = (state: string) => `<span class="dot ${state === "needs-input" || state === "needs you" ? "yellow" : state === "working" ? "green" : state === "failed" ? "red" : "gray"}" aria-hidden="true"></span>`;
  let composingReply: HTMLTextAreaElement | null = null;
  function replace(id: string, html: string) {
    const host = document.getElementById(id);
    if (!host) return;
    if (host.innerHTML !== html) swap(host, html);
    // what each card shows now is what this render meant (a skipped swap means the dom already matched)
    for (const el of host.querySelectorAll<HTMLDetailsElement>("details[data-focus-card]")) renderedOpen.set(el, el.open);
  }
  function restoreFocus(target: HTMLElement | null): boolean {
    if (!target?.isConnected || !target.closest(".view.visible, #desktop-sidebar") || target.closest("[inert], [hidden], [aria-hidden='true']") || target.matches(":disabled") || !target.getClientRects().length || getComputedStyle(target).visibility !== "visible") return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }
  function swap(host: HTMLElement, html: string) {
    const focused = document.activeElement;
    // Detaching even the same node ends native IME composition. Defer this host's
    // replacement until editing leaves it; reply controls still update in place.
    if (focused instanceof HTMLTextAreaElement && focused.dataset.focusReply && host.contains(focused)
      || composingReply && host.contains(composingReply)) return;
    const active = host.contains(focused) ? focused as HTMLInputElement : null;
    const key = active?.dataset.focusKey;
    const value = active?.value;
    const selection = active?.selectionStart;
    host.innerHTML = html;
    if (active) {
      const next = key ? host.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null;
      if (next instanceof HTMLInputElement && next.type !== "checkbox" && value !== undefined) next.value = value;
      if (restoreFocus(next)) {
        if (next instanceof HTMLInputElement && next.type === "text" && selection !== null && selection !== undefined) next.setSelectionRange(selection, selection);
      } else {
        // A missing or unusable replacement leaves focus in the visible list.
        // Inactive views must not reclaim focus from a newly opened terminal.
        const fallback = host.closest<HTMLElement>(".assistant-column") ?? host.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), summary");
        restoreFocus(fallback);
      }
    }
  }
  function addForm(first = false) {
    const label = first ? "What are you working on?" : "Add an intention";
    return `<form data-focus-form="add" class="focus-add"><input type="text" data-focus-key="add" aria-label="${label}" placeholder="${first ? "what are you working on?" : "add an intention…"}" maxlength="500" required${locked() ? " disabled" : ""}><button type="submit" data-focus-key="action:add"${locked() ? " disabled" : ""}>Add</button></form>`;
  }
  // Cards: every next row and today intention expands to its details; open state survives re-renders.
  // The summary holds only text: the action, checkbox and chips are its siblings in the row (axe nested-interactive).
  const openCards = new Set<string>();
  /** Each card element's open state as its host was last rendered (see foldOpenCards). */
  const renderedOpen = new WeakMap<HTMLDetailsElement, boolean>();
  // The user's open cards, newest last; bounded so keys of sessions that never come back do not pile up.
  const OPEN_CARDS_MAX = 64;
  const openCard = (key: string) => { openCards.delete(key); openCards.add(key); if (openCards.size > OPEN_CARDS_MAX) openCards.delete(openCards.values().next().value!); };
  // Session cards emitted by the last render (either host): only these fetch their context.
  const renderedSessions = new Map<string, FocusSession>();
  const stamp = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const field = (label: string, value: string) => value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : "";
  const project = (path?: string) => path ? `<span title="${escAttr(path)}">${esc(path.replace(/\/+$/, "").split("/").pop() || path)}</span>` : "";
  // Linked rule rows keep their intention title beside the session's context; today and starts already name it.
  function rowContext(intention?: FocusIntention, session?: FocusSession, reason?: string, hidden = false) {
    const all = sessions();
    const local = deps.localMachineName();
    const manyMachines = new Set(all.map(s => s.machine)).size > 1;
    const linked = session ? [session] : intention ? linkedFocusSessions(intention, all) : [];
    const targets = linked.length ? linked : [{ cwd: intention?.project, machine: intention?.machine, machineUrl: undefined }];
    const labels = [...new Set(targets.map(s => [project(s.cwd), s.machine && (manyMachines || s.machineUrl || s.machine !== local) ? esc(s.machine) : ""].filter(Boolean).join(" · ")).filter(Boolean))];
    const caption = reason ? [labels.join(", "), esc(reason)].filter(Boolean).join(" · ")
      : [session && intention ? esc(intention.title) : "", labels.join(", ")].filter(Boolean).join(" · ");
    return caption ? `<small class="focus-for"${hidden ? ' hidden=""' : ""}>${caption}</small>` : "";
  }
  // `open=""` is how innerHTML serializes the attribute, so an unchanged render still compares equal in replace().
  const card = (key: string, summary: string, body: string, extra = "", controls = "") => `<details class="focus-card" data-focus-card="${escAttr(key)}"${openCards.has(key) ? ' open=""' : ""}><summary data-focus-key="${escAttr(`card:${key}`)}">${summary}</summary><dl class="focus-card-body">${body}</dl>${extra}${controls}</details>`;
  // The agent-context extension's document for a session, fetched only for open session cards (local and peer
  // sessions alike, through the session's own machine). Catalogs are cached per machine; documents per session.
  const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CATALOG_TTL_MS = 5 * 60_000;
  const catalogs = new Map<string, { at: number; enabled: Promise<boolean> }>();
  const contexts = new Map<string, unknown>();
  const contextFlights = new Set<string>();
  // Re-rendering an open card fires its toggle again; only a first expand loads, refreshes reload the open ones.
  const contextTried = new Set<string>();
  const contextKey = (session: FocusSession) => `${session.machineUrl ?? ""}|${session.id}`;
  function contextEnabled(machineKey: string): Promise<boolean> {
    const cached = catalogs.get(machineKey);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.enabled;
    // "Not there" (an older peer's 404, not installed, disabled) is an answer cached for the TTL; a transport
    // failure is retried on the next refresh instead of hiding the block for the TTL.
    const enabled = deps.request<unknown>("/extensions", undefined, machineKey || undefined, false)
      .then(agentContextEnabled, e => { if (extensionUnavailable(e)) return false; catalogs.delete(machineKey); throw e; });
    catalogs.set(machineKey, { at: Date.now(), enabled });
    return enabled;
  }
  async function loadContext(session: FocusSession) {
    const key = contextKey(session);
    if (!CANONICAL_UUID.test(session.id) || contextFlights.has(key)) return;
    contextFlights.add(key);
    contextTried.add(key);
    try {
      if (!await contextEnabled(session.machineUrl ?? "")) { contexts.delete(key); return; }
      const response = await deps.request<{ document?: unknown }>(`${AGENT_CONTEXT_DOCUMENT_PATH}?session=${encodeURIComponent(session.id)}`, undefined, session.machineUrl || undefined, false);
      contexts.set(key, response.document ?? null);
    } catch (e) {
      // Removed or disabled since the catalog was read: no block, and no reads until the TTL passes.
      if (extensionUnavailable(e)) { contexts.delete(key); catalogs.set(session.machineUrl ?? "", { at: Date.now(), enabled: Promise.resolve(false) }); }
      /* otherwise an unreachable machine or a store error: keep what was shown; the next refresh retries */
    }
    finally { contextFlights.delete(key); render(); }
  }
  const openSessions = () => [...renderedSessions].filter(([key]) => openCards.has(key)).map(([, session]) => session);
  function contextHtml(session: FocusSession) {
    const context = summarizeAgentContext(contexts.get(contextKey(session)));
    if (!context) return "";
    if (context.kind === "unsupported") return `<div class="focus-context"><p class="focus-context-label">context</p><p class="focus-context-note">context panel v${esc(context.version)} not shown</p></div>`;
    // One self-contained element per needs-you item, keyed by its v3 id: a later round attaches an answer box per item.
    const need = (item: { id: string; text: string }) => `<li data-focus-need="${escAttr(item.id)}">${esc(item.text)}</li>`;
    const moreKey = `more:${session.id}`;
    const more = context.needsYou.length > 5 ? `<details class="focus-context-more" data-focus-card="${escAttr(moreKey)}"${openCards.has(moreKey) ? ' open=""' : ""}><summary data-focus-key="${escAttr(`card:${moreKey}`)}">${context.needsYou.length - 5} more</summary><ul>${context.needsYou.slice(5).map(need).join("")}</ul></details>` : "";
    const needs = field("needs you", context.needsYou.length ? `<ul class="focus-needs">${context.needsYou.slice(0, 5).map(need).join("")}</ul>${more}` : "");
    const fields = field("goal", esc(context.goal ?? "")) + field("now", esc(context.now ?? ""))
      + field("next", context.nextSteps.length ? `<ol>${context.nextSteps.map(step => `<li>${esc(step.text)}${step.owner ? ` <span class="focus-owner">${step.owner}</span>` : ""}</li>`).join("")}</ol>` : "")
      + field("need to know", context.needToKnow.length ? `<ul>${context.needToKnow.map(text => `<li>${esc(text)}</li>`).join("")}</ul>` : "");
    const fresh = [context.freshness, context.updatedAt && `updated ${age(context.updatedAt)}`].filter(Boolean).join(" · ");
    const detailsKey = `context:${session.id}`;
    return `<div class="focus-context"><p class="focus-context-label">context</p>${needs ? `<dl class="focus-card-body">${needs}</dl>` : ""}${fields ? `<details class="focus-context-more" data-focus-card="${escAttr(detailsKey)}"${openCards.has(detailsKey) ? ' open=""' : ""}><summary>more</summary><dl class="focus-card-body">${fields}</dl></details>` : ""}${fresh ? `<p class="focus-context-note">${esc(fresh)}</p>` : ""}</div>`;
  }
  function intentionBody(intention: FocusIntention, cardKey: string, reason?: string) {
    const linked = linkedFocusSessions(intention, sessions());
    return field("intention", esc(intention.title)) + field("sessions", linked.length ? `<span class="focus-chips focus-session-chips">${linked.map(session => sessionChip(session, `body:${cardKey}`)).join("")}</span>` : "none yet")
      + field("project", project(intention.project)) + field("machine", esc(intention.machine ?? "")) + field("added", stamp(intention.createdAt))
      + field("done", intention.done && intention.doneAt ? stamp(intention.doneAt) : "") + field("reason", esc(reason ?? ""));
  }
  // One wording for a next row: the row itself and the sidebar tile's "next" line.
  const nextTitle = (row: FocusAction) => row.session
    ? `${row.session.name} ${focusSessionLabel(row.session)}`
    : row.intention ? row.triage ? row.triage.reason : row.kind === "start" ? `start “${row.intention.title}”` : row.intention.title
    : `${row.triage && "sessionId" in row.triage.ref ? row.triage.ref.sessionId : "session"} · not reached`;
  // Persist the user-tap fence before sending; a reload cannot turn uncertain delivery into a retry.
  const sent = createFocusReceipts({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
  const canReply = (row: FocusAction) => !!row.session && (!!row.triage?.suggestion || row.session.state !== "needs-input" || !["permission", "auth"].includes(row.session.inputKind ?? ""));
  const receiptKey = (row: FocusAction) => row.triage?.suggestion ? focusSuggestionKey(row.triage) : row.session
    ? focusReplyKey({ machine: row.session.machineInstallationId ?? "", sessionId: row.session.id }, row.session.stoppedAt ?? row.session.changedAt ?? "") : "";
  const drafts = new Map<string, string>();
  function receiptFor(row: FocusAction): FocusSendReceipt | undefined {
    if (!canReply(row)) return;
    try {
      const key = receiptKey(row);
      const receipt = sent.get(key);
      if (receipt && receipt.state !== "retry") return receipt;
      const fence = sent.forEpisode(key);
      // A different recommendation is not the message already delivered. Keep its
      // own draft visible, but never authorize another send for the same stop.
      return fence ? { ...fence, state: "check", label: "a reply was already sent for this stop · check the session", text: undefined } : receipt;
    }
    catch (e) {
      error = e instanceof Error ? e.message : "Suggestion receipts unavailable; check the session.";
      return { label: error, at: new Date().toISOString(), state: "check" };
    }
  }
  const doneSuggestion = (row: FocusAction) => doc().intentions.find(i => i.id === row.triage?.doneIntention && !i.done);
  type RowAction = "reply" | "seen" | "done" | "open" | "start" | "intention";
  const renderedActions = new Map<string, { kind: RowAction; row: FocusAction }>();
  function describeAction(row: FocusAction, force?: "done" | "seen") {
    const done = doneSuggestion(row);
    if (force === "done" && !done || force === "seen" && (!row.session || !stoppedUnseen(row.session))) return;
    const kind: RowAction = force ?? (canReply(row) ? "reply" : done ? "done"
      : row.session ? "open" : row.kind === "start" ? "start" : "intention");
    /* Primary replies and secondary done/seen actions bind the same physical episode. */
    const ref = row.triage?.ref ?? (row.session
      ? { machine: row.session.machineInstallationId ?? "", sessionId: row.session.id }
      : row.intention ? { intentionId: row.intention.id } : undefined);
    if (!ref) return;
    const key = JSON.stringify([localOwner?.home ?? focus?.home, homeGeneration, focusNextRefKey(ref), Date.parse(row.triage?.stoppedAt ?? row.session?.stoppedAt ?? row.session?.changedAt ?? ""),
      kind, kind === "reply" ? row.triage?.suggestion : null, kind === "done" ? done?.id : null]);
    return { key, kind, row };
  }
  function bindAction(row: FocusAction, force?: "done" | "seen"): string {
    const action = describeAction(row, force);
    if (!action) return "";
    renderedActions.set(action.key, action);
    return action.key;
  }
  function currentAction(key: string) {
    const shown = renderedActions.get(key);
    if (shown) for (const row of nextRows(Infinity)) {
      const current = describeAction(row, shown.kind === "done" || shown.kind === "seen" ? shown.kind : undefined);
      if (current?.key === key && !row.unavailable) return current;
    }
    announce("This action changed; review the updated row.");
    render();
  }
  async function sendReply(row: FocusAction, actionKey: string, text: string) {
    if (!row.session || !canReply(row) || row.unavailable) return;
    const owner = captureOwner();
    // A session send is not a home-server CAS write: validate its owner before any
    // receipt or delivery, using a new read rather than a held pre-tap poll.
    await flight; requireOwner(owner);
    await refresh(); requireOwner(owner);
    // refresh keeps read-only cached rows on failure; they cannot authorize a send.
    if (focusUnavailable || !answered || !focus?.document || focus.home !== owner.home) {
      const message = error || "focus is unavailable; changes were not saved";
      throw transportFailure ? new TypeError(message) : new Error(message);
    }
    if (!currentAction(actionKey)) return;
    const key = receiptKey(row);
    const prior = receiptFor(row);
    if (prior && prior.state !== "retry") return;
    const remember = (label: string, state: "sending" | "sent" | "check" | "retry" = "check") => {
      sent.put(key, { label, at: new Date().toISOString(), state, text });
      render();
    };
    remember("sending", "sending");
    try {
      const result = await deps.request<{ outcome: SessionSendOutcome; error?: string }>("/session-control/send", {
        method: "POST", body: JSON.stringify({ session: row.session.id, text, ensureSubmitted: true }),
      }, row.session.machineUrl);
      if (result.outcome === SESSION_SEND_OUTCOME.SUBMITTED) remember(`sent to ${row.session.name}`, "sent");
      else if (result.outcome === SESSION_SEND_OUTCOME.NOT_DELIVERED) remember(result.error || "not sent · try again", "retry");
      else remember(result.outcome === SESSION_SEND_OUTCOME.PASTED_NOT_SUBMITTED ? "pasted, not submitted · check the session" : "delivery unconfirmed · check the session");
    } catch (e) {
      // A transport error does not prove that the write failed. A typed pre-write refusal can retry.
      const refusal = (e as { data?: { outcome?: string } }).data?.outcome === SESSION_SEND_OUTCOME.NOT_DELIVERED;
      remember(refusal ? "not sent · try again" : "delivery unconfirmed · check the session", refusal ? "retry" : "check");
      requireOwner(owner, OLD_HOME_DELIVERY);
      throw e;
    }
    // Keep the physical-target receipt even if delivery finished after a home move;
    // it still prevents a duplicate, but cannot authorize replay under the new owner.
    requireOwner(owner, OLD_HOME_DELIVERY);
  }
  const cardTag = (row: FocusAction) => row.triage?.suggestion ? "reply ready" : row.triage?.verdict === "needs-you" ? "needs you"
    : doneSuggestion(row) ? "mark done?" : row.session?.state === "failed" ? "failed"
    : row.session?.state === "needs-input" ? ({ permission: "approve", auth: "log in", question: "answer" }[row.session.inputKind ?? ""] ?? "needs you")
    : stoppedUnseen(row.session ?? { state: "" }) ? row.session?.state === "done" ? "done" : "stopped" : row.kind === "start" ? "start" : "needs you";
  const cardHeadline = (row: FocusAction) => row.triage?.reason ?? (row.session ? `${row.session.name} ${row.session.state === "needs-input"
    ? row.session.inputKind === "permission" ? "needs approval" : row.session.inputKind === "auth" ? "needs you to log in" : "asks a question"
    : row.session.state === "failed" ? "failed" : row.session.state === "done" ? "is done" : "stopped"}` : nextTitle(row));
  function takeHtml() {
    const current = doc();
    // Unavailable routine UI must not erase the last known stale authority.
    if (focus?.routines?.stale || !takeVisible(current, cardOrder().cards, nextOrder(0).order)) return "";
    const next = current.next!;
    return `<div class="focus-take"><div><div class="focus-take-label">assistant's take · ${esc(age(next.updatedAt))} ago</div>${esc(next.take!.text)}</div><div class="focus-take-actions"><button type="button" data-focus-action="seen-take" data-focus-at="${escAttr(next.updatedAt)}" data-focus-key="action:seen-take" aria-label="Got it: dismiss the assistant's take"${locked() ? " disabled" : ""}>got it</button>${button("talk", "reply ›", "Reply to assistant", locked() || !terminalTarget(), "take-reply")}</div></div>`;
  }
  function nextHtml(host: "d" | "p", cap: number, expanded = false) {
    const classified = cardOrder();
    const parts = [...classified.waiting.slice(0, 2).map(s => `${s.name} waiting on ${plural(s.children!.total, "sub-session")} (${s.children!.working} working)`),
      ...(classified.waiting.length > 2 ? [`+${classified.waiting.length - 2}`] : []),
      ...(classified.working ? [`${classified.working} working`] : []),
      ...new Set(classified.notReached.map(row => row.triage && "machine" in row.triage.ref ? `${deps.homeMachine(row.triage.ref.machine)?.name ?? "machine"} not reached` : "machine not reached"))];
    const quiet = `<p class="focus-quiet">${esc(classified.cards.length ? `nothing needed from you${parts.length ? ": " : ""}` : "nothing needs you")}${parts.length ? `${classified.cards.length ? "" : " · "}${esc(parts.join(" · "))}` : ""}</p>`;
    if (!classified.cards.length) return quiet;
    return `<ol class="focus-next" aria-label="Next actions">${classified.cards.slice(0, Math.max(0, cap)).map(({ row, kind: classifiedKind }, index) => {
      const kind = row.triage?.suggestion ? "suggest" : classifiedKind;
      const title = nextTitle(row);
      const receipt = receiptFor(row);
      const done = doneSuggestion(row);
      const suggest = !!row.triage?.suggestion;
      const replyBox = canReply(row);
      const actionKey = bindAction(row);
      const delivered = receipt?.state === "sent" || receipt?.state === "check";
      const reply = ((delivered || receipt?.state === "sending") ? receipt?.text : undefined) ?? drafts.get(actionKey) ?? row.triage?.suggestion ?? "";
      const readOnly = sessionLocked() || row.unavailable || delivered || receipt?.state === "sending";
      const name = row.session?.name ?? title;
      const messageId = `fd-${host}-${index}`;
      const verb = replyBox ? receipt?.state === "sending" ? "sending…" : receipt?.state === "retry" ? `retry send to ${name}` : `send to ${name}` : done ? "done" : row.kind === "intention" ? "review" : focusActionVerb(row);
      // A start row and the same intention's today card are separate cards: `start:` here, `intention:` in today.
      const key = row.session ? `session:${row.session.machineInstallationId ?? ""}:${row.session.id}` : row.intention ? `start:${row.intention.id}` : `unavailable:${JSON.stringify(row.triage?.ref)}`;
      if (row.session) renderedSessions.set(key, row.session);
      const actionName = replyBox ? `Send to ${row.session?.name ?? title}` : done ? `Mark done: ${done.title}` : row.session ? `${verb} ${title}` : title;
      const action = replyBox && (receipt?.state === "sent" || receipt?.state === "check") ? "" : `<button type="button"${replyBox ? ` aria-describedby="${messageId}-description"` : ' class="focus-action"'}${sessionLocked() || row.unavailable || (replyBox && (!reply.trim() || receipt && receipt.state !== "retry")) ? " disabled" : ""} data-focus-next="${escAttr(actionKey)}" data-focus-key="${escAttr(`act:${key}`)}" aria-label="${escAttr(actionName)}">${esc(verb)}${verb === "sending…" ? "" : '<span aria-hidden="true"> ›</span>'}</button>`;
      const open = row.session ? `<button type="button" data-focus-session="${escAttr(row.session.id)}" data-focus-key="${escAttr(`open:${key}`)}" aria-label="${escAttr(`Open ${name}`)}"${sessionLocked() || row.unavailable ? " disabled" : ""}>open<span aria-hidden="true"> ›</span></button>` : "";
      const meta = row.session ? [`<b>${esc(name)}</b>`, row.session.changedAt && age(row.session.changedAt), project(row.session.cwd), new Set(sessions().map(s => s.machine)).size > 1 && esc(row.session.machine ?? "")].filter(Boolean).join(" · ") : [project(row.intention?.project), row.intention?.machine && row.intention.machine !== deps.localMachineName() ? esc(row.intention.machine) : ""].filter(Boolean).join(" · ");
      const lineChars = Array.from(row.session?.lastLine ?? "");
      const preview = lineChars.length > 100 ? "…" + lineChars.slice(-100).join("") : lineChars.join("");
      const summary = `<span class="focus-tag">${esc(cardTag(row))}${suggest && drafts.has(actionKey) && reply !== row.triage?.suggestion && !delivered ? " · edited" : ""}</span><span class="focus-title">${esc(cardHeadline(row))}</span><span class="focus-meta">${meta}</span>${!row.triage && preview ? `<q class="focus-meta">${esc(preview)}</q>` : ""}`;
      const lastLine = lineChars.length > 160 ? "…" + lineChars.slice(-160).join("") : lineChars.join("");
      const draft = replyBox ? `<div id="${messageId}-caption" class="focus-caption">message to ${esc(name)} · typed into its terminal and submitted</div><textarea id="${messageId}" data-focus-reply="${escAttr(actionKey)}" data-focus-key="${escAttr(`reply:${actionKey}`)}" aria-label="${escAttr(`reply to ${name}`)}" aria-describedby="${messageId}-caption" placeholder="${kind === "done" ? "follow up with" : "reply to"} ${escAttr(name)}…" maxlength="${FOCUS_REPLY_MAX_LENGTH}" rows="1"${readOnly ? " readonly" : ""}>${esc(reply)}</textarea><span id="${messageId}-description" class="visually-hidden">${esc(reply)}</span>${receipt && receipt.state !== "sending" ? `<small role="status"${receipt.state === "sent" ? "" : ' class="focus-notes"'}>${receipt.state === "sent" ? `✓ ${esc(receipt.label)} · ${age(receipt.at)} ago` : esc(receipt.label)}</small>` : ""}${action} ${suggest && !delivered && reply !== row.triage!.suggestion! ? `<button type="button" data-focus-reset="${escAttr(actionKey)}" data-focus-key="${escAttr(`reset:${actionKey}`)}"${readOnly ? " disabled" : ""}>reset</button>` : ""}${done ? `<button type="button" data-focus-mark-done="${escAttr(bindAction(row, "done"))}" aria-label="${escAttr(`Mark done: ${done.title}`)}" data-focus-key="${escAttr(`done:${key}`)}"${sessionLocked() || row.unavailable ? " disabled" : ""}>done ›</button>` : ""}` : "";
      const body = row.session ? field(`last line from ${esc(name)}`, lastLine ? `<q><code>${esc(lastLine)}</code></q>` : "")
        + (row.triage ? `<div data-focus-clamped hidden><dt>assistant</dt><dd>${esc(row.reason)}</dd></div>` : "") + field("for", esc(row.intention?.title ?? ""))
        : row.intention ? intentionBody(row.intention, key, row.triage?.reason ?? "no live session") : field("reason", esc(row.reason));
      const controls = `<div class="focus-draft">${draft}${!replyBox && (!row.session || done) ? action : ""}${row.session && !replyBox ? '<span class="focus-caption">answer in the terminal</span>' : ""}${row.unavailable ? '<p class="focus-notes">not reached</p>' : ""}${kind === "done" ? `<button type="button" data-focus-next="${escAttr(bindAction(row, "seen"))}" data-focus-key="${escAttr(`seen:${key}`)}"${sessionLocked() || row.unavailable ? " disabled" : ""}>mark seen</button>` : ""}${open}</div>`;
      return `<li data-kind="${kind}"${index >= 3 && !expanded ? ' class="focus-extra"' : ""}>${card(key, summary, body, row.session ? contextHtml(row.session) : "", controls)}</li>`;
    }).join("")}</ol>${quiet}`;
  }
  function syncReplyControls() {
    for (const field of document.querySelectorAll<HTMLTextAreaElement>("textarea[data-focus-reply]")) {
      const key = field.dataset.focusReply!;
      const action = renderedActions.get(key);
      const row = action?.row;
      const receipt = row && receiptFor(row);
      const delivered = receipt?.state === "sent" || receipt?.state === "check";
      const readOnly = !row || sessionLocked() || !!row.unavailable || delivered || receipt?.state === "sending";
      const text = ((delivered || receipt?.state === "sending") ? receipt?.text : undefined) ?? drafts.get(key) ?? row?.triage?.suggestion ?? field.value;
      field.readOnly = readOnly;
      if (field !== document.activeElement && field !== composingReply && field.value !== text) field.value = text;
      const description = document.getElementById(`${field.id}-description`);
      if (description) description.textContent = text;
      const block = field.closest<HTMLElement>(".focus-draft")!;
      const send = block.querySelector<HTMLButtonElement>("[data-focus-next][aria-describedby]");
      if (send) send.disabled = readOnly || !text.trim();
      const tag = block.closest("details")?.querySelector<HTMLElement>(".focus-tag");
      if (tag && row?.triage?.suggestion) tag.textContent = `reply ready${!delivered && text !== row.triage.suggestion ? " · edited" : ""}`;
      let reset = block.querySelector<HTMLButtonElement>("[data-focus-reset]");
      if (row?.triage?.suggestion && !delivered && text !== row.triage.suggestion) {
        if (!reset) {
          reset = document.createElement("button");
          reset.type = "button"; reset.textContent = "reset";
          reset.dataset.focusReset = key; reset.dataset.focusKey = `reset:${key}`;
          block.insertBefore(reset, block.querySelector("[data-focus-mark-done], [data-focus-session]"));
        }
        reset.disabled = readOnly;
      } else reset?.remove();
    }
  }
  function sessionChip(session: FocusSession, key: string, hidden = false) {
    return `<button type="button"${hidden ? ' class="focus-chip-extra"' : ""}${sessionLocked() ? " disabled" : ""} data-focus-key="${escAttr(`${key}:${session.id}`)}" data-focus-session="${escAttr(session.id)}" title="${escAttr(session.name)}">${dot(session.state)}<span class="focus-chip-name">${esc(session.name)}</span></button>`;
  }
  const compactChips = new Map<string, { count: number; width: number; showContext: boolean }>();
  // Compact presentation only: preserve link order within each attention tier.
  const chipAttention = (session: FocusSession) => session.state === "needs-input" || session.state === "failed" ? 0 : session.state === "working" ? 1 : 2;
  function chipsHtml(intention: FocusIntention) {
    const linked = linkedFocusSessions(intention, sessions()).sort((a, b) => chipAttention(a) - chipAttention(b));
    if (!linked.length) return '<span class="focus-chips"></span>';
    const count = Math.min(compactChips.get(intention.id)?.count ?? linked.length, linked.length);
    const chips = linked.map((session, index) => sessionChip(session, `chip:${intention.id}`, index >= count)).join("");
    const rest = linked.slice(count);
    // Keep the hidden zero-count button as the native sizing probe when all chips fit.
    const more = `<button type="button" class="focus-chip-more${rest.length ? "" : " focus-chip-none"}" data-focus-expand="${escAttr(`intention:${intention.id}`)}" data-focus-key="${escAttr(`chips:${intention.id}`)}" aria-label="${escAttr(`${rest.length} more sessions: ${rest.map(s => s.name).join(", ")}`)}" title="${escAttr(rest.map(s => s.name).join(", "))}">+${rest.length}</button>`;
    return `<span class="focus-chips" data-focus-chips="${escAttr(intention.id)}">${chips}${more}</span>`;
  }
  // Measure native button widths, including the current font, padding and dots. Keep the
  // largest prefix that fits with +n; only a lone overlong name needs truncation.
  function fitChips(): boolean {
    if (!isDesktop()) return false;
    let changed = false;
    for (const chips of document.querySelectorAll<HTMLElement>("[data-focus-chips]")) {
      const row = chips.parentElement!;
      const summary = row.querySelector<HTMLElement>("summary")!;
      if (!summary.clientWidth || row.querySelector(".focus-card[open]")) continue;
      const title = summary.querySelector(".focus-title")!;
      const range = document.createRange();
      range.selectNode(title.firstChild!);
      // Reserve the intention's own text before chips; its context may yield.
      const disclosure = getComputedStyle(summary, "::after");
      const endWidth = parseFloat(disclosure.width) + parseFloat(disclosure.marginLeft) + parseFloat(disclosure.marginRight);
      const titleSpace = summary.clientWidth - endWidth - 2 * parseFloat(getComputedStyle(summary).columnGap);
      const gap = parseFloat(getComputedStyle(chips).columnGap);
      const more = chips.querySelector<HTMLButtonElement>(".focus-chip-more")!;
      const original = more.textContent;
      chips.classList.add("focus-chip-measure");
      const widths = [...chips.querySelectorAll<HTMLElement>("[data-focus-session]")].map(el => el.getBoundingClientRect().width);
      more.textContent = `+${widths.length}`;
      const available = Math.max(Math.ceil(more.getBoundingClientRect().width), Math.floor(titleSpace - range.getBoundingClientRect().width));
      let count = widths.length;
      let width = 0;
      while (count >= 0) {
        const remaining = widths.length - count;
        more.textContent = `+${remaining}`;
        width = widths.slice(0, count).reduce((sum, width) => sum + width, 0) + Math.max(0, count - 1) * gap
          + (remaining ? (count ? gap : 0) + more.getBoundingClientRect().width : 0);
        // Preserve the existing lone long-name ellipsis, with the full name in its title.
        if (width <= available || widths.length === 1) break;
        count--;
      }
      width = Math.min(available, Math.ceil(width));
      more.textContent = original;
      chips.classList.remove("focus-chip-measure");
      const context = summary.querySelector<HTMLElement>(".focus-for");
      const duplicatesChip = count > 0 && context?.querySelector("span")?.textContent === chips.querySelector(".focus-chip-name")?.textContent;
      // Leave at least ~8 characters plus the context's margin, or yield entirely.
      const showContext = !duplicatesChip && titleSpace - range.getBoundingClientRect().width - width >= 74;
      const previous = compactChips.get(chips.dataset.focusChips!);
      if (previous?.count !== count || previous.width !== width || previous.showContext !== showContext) {
        compactChips.set(chips.dataset.focusChips!, { count, width, showContext });
        changed = true;
      }
    }
    return changed;
  }
  function todayHtml(items: FocusIntention[]) {
    return `<ul class="focus-today" aria-label="Intentions">${items.map(i => `<li style="--f-chips:${compactChips.get(i.id)?.width ?? 0}px"${i.done ? ' class="done"' : ""}><label class="focus-check"><input type="checkbox" data-focus-done="${escAttr(i.id)}" data-focus-key="${escAttr(i.id)}" aria-label="Done: ${escAttr(i.title)}"${i.done ? " checked" : ""}${locked() ? " disabled" : ""}></label>${card(`intention:${i.id}`, `<span class="focus-title">${esc(i.title)}${rowContext(i, undefined, undefined, isDesktop() && compactChips.get(i.id)?.showContext === false)}</span>`, intentionBody(i, `intention:${i.id}`))}${chipsHtml(i)}${!i.done && !linkedFocusSessions(i, sessions()).length ? `<button type="button" class="focus-action" data-focus-start="${escAttr(i.id)}" data-focus-key="${escAttr(`start:${i.id}`)}" aria-label="${escAttr(`start “${i.title}”`)}"${sessionLocked() ? " disabled" : ""}>start ›</button>` : ""}</li>`).join("")}</ul>`;
  }
  // The live dom holds the newest open state: a tap sets `open` at once, but the browser queues its toggle event, and a
  // render in between would rebuild the card from `openCards` and the toggle would then fire on the detached node (N6).
  // A card whose dom state differs from what the last render gave it was toggled since: take that before building html.
  // (Not compared with `openCards`: the other host's copy of a card toggled elsewhere is stale, not a toggle.)
  function foldOpenCards() {
    for (const id of ["dashboard-focus", "assistant-content"]) {
      for (const el of document.getElementById(id)?.querySelectorAll<HTMLDetailsElement>("details[data-focus-card]") ?? []) {
        const rendered = renderedOpen.get(el);
        if (rendered === undefined || el.open === rendered) continue;
        if (el.open) openCard(el.dataset.focusCard!); else openCards.delete(el.dataset.focusCard!);
      }
    }
  }
  function render() {
    foldOpenCards();
    renderedSessions.clear();
    renderedActions.clear();
    const current = doc();
    for (const id of compactChips.keys()) if (!current.intentions.some(intention => intention.id === id && linkedFocusSessions(intention, sessions()).length > 0)) compactChips.delete(id);
    const enabled = !!focus?.assistant?.enabled;
    const state = status();
    // The unavailable header already names the outage; keep transport diagnostics in settings.
    const assistantError = terminalUnavailable() ? "" : focus?.assistant?.error;
    const next = nextRows(pageNextCap());
    const allNext = nextRows(Infinity);
    const draftKeys = new Set(allNext.filter(row => canReply(row) && receiptFor(row)?.state !== "sent").map(row => describeAction(row)?.key));
    for (const key of drafts.keys()) if (!draftKeys.has(key)) drafts.delete(key);
    const nextCount = allNext.length;
    const cards = cardOrder().cards;
    const replyReady = cards.filter(({ row }) => !!row.triage?.suggestion).length;
    const doneCards = cards.filter(card => card.kind === "done").length;
    const actionCards = nextCount - replyReady - doneCards;
    const nextCounts = [
      { count: actionCards, text: `${actionCards} ${actionCards === 1 ? "needs" : "need"} you` },
      { count: replyReady, text: `${replyReady} reply ready` },
      { count: doneCards, text: `${doneCards} done` },
    ].filter(item => item.count > 0);
    const nextSummary = nextCounts.map(item => item.text).join(" · ") || "0";
    const firstCount = nextCounts[0];
    const remainingCards = nextCount - (firstCount?.count ?? 0);
    const tileSummary = firstCount ? `${firstCount.text}${remainingCards ? ` +${remainingCards}` : ""}` : "0";
    const visibleNext = isDesktop() ? 5 : 3;
    const moreNext = !showAllNext && nextCount > visibleNext ? `<p>${button("more-next", `show ${nextCount - visibleNext} more`)}</p>` : "";
    const summary = `${current.intentions.filter(i => i.done).length} of ${current.intentions.length} done`;
    // "know when items are done": today's ticks and finishes carry a time; the rest of the list stays as it was.
    const done = doneToday(current, sessions(), Date.now(), doneDay);
    const grouped = groupFocusDone(done);
    const doneGroupHtml = (groups: FocusDoneGroup[], finished: boolean) => groups.length ? `<h3>${finished ? "finished" : "work finished, intention still open"}</h3><ul aria-label="${finished ? "Finished intentions" : "Finished work still open"}">${groups.map(group => {
      const i = group.intention;
      return `<li><div><span class="focus-what">${finished ? "✓" : "○"} ${esc(i.title)}</span>${finished ? `<span class="focus-time">${clock(group.at)}</span><button type="button" data-focus-undo="${escAttr(i.id)}" data-focus-key="${escAttr(`undo:${i.id}`)}" aria-label="Undo done: ${escAttr(i.title)}"${locked() ? " disabled" : ""}>undo</button>`
        : `<button type="button" data-focus-complete="${escAttr(i.id)}" data-focus-key="${escAttr(`complete:${i.id}`)}" aria-label="Mark done: ${escAttr(i.title)}"${locked() ? " disabled" : ""}>done ›</button>`}</div>${group.sessions.length ? `<ul>${group.sessions.map(({ session, at }) => `<li><span class="focus-what">· ${esc(session.name)}${session.machine ? ` · ${esc(session.machine)}` : ""} · <span class="focus-time">${clock(at)}</span></span>${!finished ? `<button type="button" data-focus-session="${escAttr(session.id)}" data-focus-key="${escAttr(`done:${i.id}:${session.id}`)}" aria-label="Open ${escAttr(session.name)}"${sessionLocked() ? " disabled" : ""}>open ›</button>` : ""}</li>`).join("")}</ul>` : ""}</li>`;
    }).join("")}</ul>` : "";
    const doneHtml = done.length ? `<h2>done today <small>${grouped.finished.length} finished · ${grouped.open.length} finished work still open</small></h2><div class="focus-done">${doneGroupHtml(grouped.finished, true)}${doneGroupHtml(grouped.open, false)}</div>` : "";
    const open = current.intentions.filter(i => !(i.done && i.doneAt && doneDay(i.doneAt) === localDay(Date.now())));
    const r = routines();
    const catching = r?.catchingUp;
    // Every state names the user's move: answer, catch up now, look at its terminal; never only what the system is doing.
    const unavailableInfo = "focus unavailable · read-only";
    const info = offline() ? `focus from ${current.updatedAt ? when(current.updatedAt) : "cache"} · ${homeName} offline · read-only`
      : focusUnavailable ? `${unavailableInfo} · details in settings`
      : terminalUnavailable() ? "sessions unavailable · focus is saved here"
      : state === "needs you" ? "needs you · answer"
      : r?.surfaced ? `has not confirmed reading activity · sent ${r.surfaced.sends} times`
      : catching?.unconfirmed ? `reading activity · ${DELIVERY_UNCONFIRMED}`
      : catching ? `reading activity${catching.since ? ` since ${when(catching.since)}` : ""} · ${plural(catching.machines, "machine")}`
      : r?.stale ? `quiet since ${when(r.stale.since)}` : `${state} · ${freshness()}`;
    const catchUp = button("catch-up", "catch up now", "catch up now", !!terminalUnavailable());
    const noteItems = [...(r ? [...r.unreachable.map(m => esc(`${m.name} not reached ${m.since ? `since ${when(m.since)}` : "yet"} · its day is reviewed when it is back`)), ...(r.surfaced ? [`${r.stale ? `quiet since ${when(r.stale.since)} · ` : ""}look at its terminal, then ${catchUp}`] : []), ...(r.stale && !r.surfaced ? [catchUp] : []), ...[r.notice, r.error].filter(Boolean).map(t => esc(t!))] : []), ...(!focusUnavailable && enabled && assistantError ? [esc(assistantError)] : [])].map(n => `<span>${n}</span>`).join("");
    const notes = noteItems ? `<p class="focus-notes">${noteItems}</p>` : "";
    const summaryDay = current.daySummary;
    // A day note stays listed until it is marked read after that activity day ended (its turn at the
    // fallback time, from the home server; calendar midnight when routines are unavailable). seenDayNoteAt is shared across devices.
    const noteDay = r?.yesterday?.date === summaryDay?.date ? r?.yesterday : undefined;
    const dayEnd = summaryDay && (noteDay ? Date.parse(noteDay.endsAt) : new Date(`${summaryDay.date}T00:00`).getTime() + 864e5);
    const yesterday = summaryDay && !(current.seenDayNoteAt && Date.parse(current.seenDayNoteAt) >= dayEnd!)
      ? `<div class="focus-yesterday"><h2>${dayName(summaryDay.date)}</h2><span>· <span${summaryDay.questions ? ' class="focus-questions"' : ""}>${plural(summaryDay.questions, "question")} for you</span> · ${summaryDay.carried} carried over · ${summaryDay.done} done</span>${button("day-note", "read ›", `Read day note for ${summaryDay.date}`, noteDay?.note === false)}</div>` : "";
    // The dot follows the user's move: amber while a routine waits, red when focus is unavailable.
    const tone = dot(focusUnavailable ? "failed" : r?.surfaced ? "needs you" : state);
    const sessionNotice = answered && !focusUnavailable && !terminalUnavailable() && deps.sessionsUnavailable() ? "<small>sessions unavailable</small>" : "";
    // Nothing of the focus ui shows while the assistant is off: tile, block and page stay hidden; settings is the only door.
    // Disabled from another device while the page is open: leave it once, on the transition (show re-enters render).
    const closing = wasEnabled && !enabled;
    wasEnabled = enabled;
    if (closing && document.getElementById("assistant-view")?.classList.contains("visible")) deps.show("sessions");
    const tile = document.getElementById("sidebar-assistant");
    const tileState = focusUnavailable ? (offline() ? "offline" : "focus unavailable") : !focus?.document ? "set focus" : terminalUnavailable() ? "unavailable" : state === "needs you" ? state : state === "failed" ? "failed" : r?.surfaced ? "needs you" : catching ? "reading" : r?.stale ? `quiet ${age(r.stale.since)}` : null;
    const tileStatus = `${tileState ? `${tileState} · ` : ""}${tileSummary}`;
    const fullTileStatus = `${tileState ? `${tileState} · ` : ""}${nextSummary}`;
    const needsYouCount = actionCards;
    const suggestions = replyReady;
    const attentionLabel = nextSummary;
    dashboardAttention = needsYouCount > 0 || suggestions > 0 || sessions().some(session => session.state === "failed") || state === "needs you" || state === "failed" || !!r?.surfaced;
    const dashboardExpanded = dashboardDisclosure().expanded(dashboardAttention);
    const sidebarExpanded = desktopDisclosure.expanded(dashboardAttention);
    // Keep frame buttons attached across polls: replacing a focused button between Space down/up cancels native activation.
    const disclosureFrame = (id: string) => `<button id="${id}" type="button" class="focus-mobile-toggle" data-focus-action="toggle-dashboard" data-focus-key="action:toggle-dashboard"></button>`;
    const disclosure = (id: string, details: string, expanded: boolean, summary = true) => {
      const toggle = document.getElementById(id);
      if (!toggle) return;
      toggle.setAttribute("aria-controls", details);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} assistant ${state} ${attentionLabel}`);
      replace(id, `${summary ? `<b>assistant</b> <span class="focus-title">${esc(state)}</span> <span>${esc(attentionLabel)}</span>` : ""}<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`);
    };
    if (tile) {
      updateSidebarVisibility();
      // The tile's tone drives its glow: amber when the user's move is due, a pulse while it reads or works, red offline.
      tile.dataset.tone = focusUnavailable || terminalUnavailable() || state === "failed" ? "failed" : state === "needs you" || r?.surfaced ? "attn" : catching || state === "working" ? "busy" : "rest";
      const countedNext = tileState === null;
      const upNext = next[0] ? `<i aria-hidden="true">next</i> ${countedNext ? "" : '<span class="visually-hidden">next:</span> '}${esc(cardHeadline(next[0]))}` : esc(focus?.document ? "nothing queued" : "set your focus");
      const head = sidebarExpanded ? `${TILE_MARK}<b>assistant<span class="visually-hidden">,</span></b><span class="assistant-tile-state" title="${escAttr(fullTileStatus)}">${tone}${esc(tileStatus)}${countedNext && next[0] ? '<span class="visually-hidden">:</span>' : ""}</span>`
        : `<span class="visually-hidden">assistant</span>${tone}<span class="focus-title">${esc(tileState ?? state)}</span><span>${esc(tileSummary)}</span>`;
      if (!tile.firstElementChild) replace("sidebar-assistant", `<button id="sidebar-assistant-nav" type="button" aria-describedby="sidebar-assistant-summary" data-focus-action="view" data-focus-key="action:sidebar-view"></button>${disclosureFrame("sidebar-assistant-toggle")}`);
      replace("sidebar-assistant-nav", `<span class="assistant-tile-head">${head}</span><span id="sidebar-assistant-details" class="assistant-tile-next"${sidebarExpanded ? "" : ' hidden=""'}>${upNext}</span><span id="sidebar-assistant-summary" hidden>${esc(fullTileStatus)}</span>`);
      disclosure("sidebar-assistant-toggle", "sidebar-assistant-details", sidebarExpanded, false);
      tile.title = fullTileStatus;
    }
    const block = document.getElementById("dashboard-focus");
    if (block) { block.hidden = !enabled; block.dataset.mobileCollapsed = String(!dashboardExpanded); }
    const attn = state === "needs you" ? `<button type="button" class="focus-attn" data-focus-action="talk" data-focus-key="action:attn">${dot(state)} ${esc(info)} ›</button>` : "";
    if (enabled && block && !block.firstElementChild) replace("dashboard-focus", `${disclosureFrame("dashboard-focus-toggle")}<div id="dashboard-focus-details" class="focus-dashboard-body"></div>`);
    if (!enabled) replace("dashboard-focus", "");
    else {
      disclosure("dashboard-focus-toggle", "dashboard-focus-details", dashboardExpanded);
      const details = document.getElementById("dashboard-focus-details");
      if (details) details.hidden = !dashboardExpanded;
    }
    const dashboardBody = !enabled ? "" : `<div class="focus-header">${attn || `${tone}${button("view", "assistant", "Open assistant", false, "view-title")}<small${catching ? ' class="focus-spin"' : ""}>${esc(info)}</small>`}${sessionNotice}<small>${esc(orderLabel())}</small>${button("view", "open assistant ›", "Open assistant page")}</div>${notes}${focus?.document ? nextHtml("d", 3) + takeHtml() + `<small>${esc(nextSummary)}${current.intentions.length ? ` · today ${summary}` : ""}</small>` : `<p>Set your focus</p>${addForm(true)}`}${error && !focusUnavailable ? `<p role="status">${esc(error)}</p>` : ""}`;
    replace("dashboard-focus-details", dashboardBody);
    replace("assistant-content", !enabled ? "" : `<div class="focus-header">${attn || `<span title="${escAttr(info)}"${catching ? ' class="focus-spin"' : ""}>${tone} ${esc(info)}</span>`}${sessionNotice}<small>${esc(orderLabel())}</small><span class="focus-header-actions"><button type="button" class="focus-talk" data-focus-action="talk" data-focus-key="action:talk" aria-label="Talk to assistant"${terminalUnavailable() ? ` title="${escAttr(terminalUnavailable()!)}"` : ""}${!terminalTarget() ? " disabled" : ""}>talk<span aria-hidden="true"> ›</span></button>${button("settings", "settings", "Assistant settings")}</span></div>${notes}<h2>next <small>${esc(nextSummary)}</small></h2>${nextHtml("p", pageNextCap(), showAllNext)}${moreNext}${takeHtml()}${current.intentions.length && next.length ? `<details><summary>why this order</summary><ol>${next.map(r => `<li>${esc(r.reason)}</li>`).join("")}</ol></details>` : ""}${current.intentions.length ? `<h2>today <small>${summary}</small></h2>${todayHtml(open)}` : ""}${addForm(!focus?.document)}<small>reorder, reword or drop: tell the assistant</small>${doneHtml}${yesterday}`);
    syncReplyControls();
    for (const field of document.querySelectorAll<HTMLElement>("[data-focus-clamped]")) {
      const headline = field.closest("details")?.querySelector<HTMLElement>("summary .focus-title");
      field.hidden = !headline || headline.scrollHeight <= headline.clientHeight;
    }
    const live = document.getElementById("focus-status");
    if (live) live.textContent = focusUnavailable ? "" : error || assistantError || (focus?.assistant?.queued ? `${focus.assistant.queued} queued${terminalUnavailable() ? " · sends when the broker is back" : ""}` : notice);
    const setting = document.getElementById("assistant-setting-status");
    if (setting) setting.textContent = enabled ? `on · ${focusUnavailable && !offline() ? unavailableInfo : info}` : focusUnavailable ? (offline() ? `${homeName} offline · read-only` : unavailableInfo) : "off";
    const settingError = document.getElementById("assistant-setting-error");
    if (settingError) settingError.textContent = offline() ? "" : error || focus?.assistant?.error || "";
    renderHomePicker(); syncTimingControls();
    const settingHome = document.getElementById("assistant-setting-home");
    if (settingHome) settingHome.textContent = `Home: ${homeName}${focus?.assistant?.folder ? ` · ${focus.assistant.folder}` : ""}. Needs pi installed and logged in there (pi, then /login).`;
    const toggle = document.getElementById("assistant-setting-toggle") as HTMLButtonElement;
    if (toggle) { toggle.textContent = enabled ? "Disable assistant…" : "Enable assistant…"; toggle.disabled = locked() || !!terminalUnavailable(); toggle.title = terminalUnavailable() ?? ""; }
    const settingOpen = document.getElementById("assistant-setting-open");
    if (settingOpen) settingOpen.hidden = !enabled;
    const terminalState = document.getElementById("assistant-terminal-state");
    if (terminalState) terminalState.textContent = terminalUnavailable() ? "sessions unavailable" : focus?.assistant?.queued ? `${focus.assistant.queued} queued` : focus?.assistant?.error ?? state;
    // The existing focus/session refresh owns this projection; the pane never polls or watches work.
    deps.terminalTarget(terminalTarget(),
      offline() ? `${homeName} is offline. the terminal reconnects when it is back.` : terminalUnavailable() ? "the terminal is unavailable while the broker reconnects." : focusUnavailable ? "the assistant terminal is unavailable. check sessions and focus settings." : "the assistant terminal is not running yet.");
    if (fitChips()) render();
  }
  async function refresh(open = !opened) {
    if (flight) return flight;
    opened = true;
    flight = (async () => {
      const epoch = writes;
      let generation = homeGeneration;
      try {
        let response: FocusResponse;
        try { response = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, undefined, false); }
        catch (e) {
          // Only the serving machine's error can identify the local owner;
          // a remote 503 describes that peer, not this installation.
          const identity: unknown = (e as { data?: unknown })?.data;
          if (generation === homeGeneration && isFocusHomeIdentity(identity)) {
            localInstallationId = identity.installationId;
            const changed = acceptOwner(identity);
            generation = homeGeneration;
            const home = identity.local ? { key: "", name: "this machine" } : deps.homeMachine(identity.home);
            machine = home?.key ?? ""; homeName = home?.name ?? identity.home;
            if (changed) focus = undefined;
          }
          throw e;
        }
        if (generation !== homeGeneration) return;
        localInstallationId = response.installationId;
        const changed = acceptOwner({ home: response.home, installationId: response.installationId, local: response.local });
        generation = homeGeneration;
        const home = response.local ? { key: "", name: "this machine" } : deps.homeMachine(response.home);
        homeName = home?.name ?? (focus?.home === response.home ? homeName : "sgt");
        if (focus && focus.home !== response.home) focus = { ...response, document: null };
        machine = home?.key ?? "";
        if (!response.local) {
          if (!home) { if (focus?.home !== response.home) focus = { ...response, document: null }; throw new TypeError(`${homeName} offline`); }
          const remote = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, machine, false);
          if (generation !== homeGeneration) return;
          if (!remote.local || remote.installationId !== response.home) throw new FocusOwnershipError("focus home identity changed");
          response = remote;
        }
        if (response.document !== null && !isFocusDocument(response.document)) throw new Error("invalid focus document");
        // A write saved while this poll was in flight is newer than the document it carries: keep the written one.
        focus = writes !== epoch && focus?.home === response.home ? { ...response, document: focus.document, revision: focus.revision } : response;
        terminalOwner = "eligible";
        focusUnavailable = false; transportFailure = false; error = "";
        for (const session of openSessions()) void loadContext(session);
        cache(focus);
        if (changed && document.getElementById("settings-view")?.classList.contains("visible")) void loadTiming();
      } catch (e) {
        if (generation !== homeGeneration) return;
        if (e instanceof FocusOwnershipError) {
          terminalOwner = "rejected";
          if (focus) cache(focus);
        }
        focusUnavailable = true;
        transportFailure = isTransportFailure(e);
        error = e instanceof Error ? e.message : "focus unavailable";
      }
      answered = true;
      render();
    })().finally(() => { flight = undefined; });
    return flight;
  }
  async function write(op: FocusOp | (() => FocusOp), owner = captureOwner()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      requireOwner(owner);
      if (focusUnavailable) throw new Error("focus is unavailable; changes were not saved");
      if (!answered) throw new Error("focus is still loading; changes were not saved");
      try {
        const saved = await deps.request<FocusResponse>("/focus", { method: "POST", body: JSON.stringify({ expectedRevision: doc().revision, ops: [typeof op === "function" ? op() : op] }) }, owner.machine);
        requireOwner(owner, OLD_HOME_COMPLETED);
        if (saved.home !== owner.home) throw new FocusHomeChanged();
        focus = { ...focus, ...saved, assistant: focus?.assistant };
        writes++;
        cache(focus);
        announce("focus updated");
        return;
      } catch (e) {
        if ((e as { status?: number }).status !== 409) throw e;
        const rejected: unknown = (e as { data?: unknown }).data;
        if (isFocusHomeIdentity(rejected) && (!rejected.local || rejected.home !== owner.home)) {
          // Revoke held polls only for the rejected owner, never a newer home's authority.
          if (ownerIsCurrent(owner)) {
            homeGeneration++; focusUnavailable = true; terminalOwner = "rejected";
            deps.terminalTarget(null);
          }
          throw new FocusHomeChanged();
        }
        if (attempt) throw e;
        await refresh(); requireOwner(owner);
      }
    }
  }
  async function readDayNote() {
    const owner = captureOwner();
    const date = doc().daySummary?.date;
    if (!date) return;
    const note = await deps.request<{ markdown: string }>(`/focus/day-note?date=${date}`, undefined, owner.machine);
    requireOwner(owner);
    if (await showAppDialog({ title: `Day note ${date}`, message: "The day's assistant write-ups.", content: createDayNoteContent(note.markdown), confirmLabel: "Mark read", cancelLabel: "Close" })) {
      requireOwner(owner);
      await write({ type: "seen-day-note", at: new Date().toISOString() }, owner);
    }
  }
  const timingForm = document.getElementById("assistant-timing") as HTMLFormElement | null;
  const timingStatus = (text: string, state: string) => { const el = document.getElementById("assistant-timing-status"); if (el) { el.textContent = text; el.dataset.state = state; } };
  function syncTimingControls() {
    const disabled = !timingOwner || !ownerIsCurrent(timingOwner) || !!timingSave;
    for (const control of timingForm?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button") ?? []) control.disabled = disabled;
  }
  async function loadTiming() {
    const starting = localOwner && { home: localOwner.home, generation: homeGeneration };
    const load = ++timingLoad;
    timingOwner = undefined; syncTimingControls();
    await refresh();
    if (!timingForm || load !== timingLoad || starting && !ownerIsCurrent(starting)) return;
    let owner: HomeOwner | undefined;
    try {
      owner = captureOwner();
      const timing = (await deps.request<{ settings: { assistant: AssistantTiming } }>("/settings", undefined, owner.machine, false)).settings.assistant;
      if (load !== timingLoad || !ownerIsCurrent(owner)) return;
      for (const [key, value] of Object.entries(timing)) (timingForm.elements.namedItem(key) as HTMLInputElement).value = String(value);
      timingOwner = owner; syncTimingControls();
      timingStatus(`Routine timing on ${owner.name}.`, "idle");
    } catch {
      if (load === timingLoad && (!owner || ownerIsCurrent(owner))) timingStatus(`Could not load routine timing from ${owner?.name ?? "the focus home"}.`, "error");
    }
  }
  // The home server validates; a field error is worded with that field's own label and marks the input.
  timingForm?.addEventListener("submit", event => {
    event.preventDefault();
    const owner = timingOwner;
    if (!owner || !ownerIsCurrent(owner)) { timingStatus(HOME_CHANGED, "error"); return; }
    if (timingSave) return;
    const values = Object.fromEntries([...new FormData(timingForm)].map(([key, value]) => [key, key === "fallbackTime" ? String(value) : Number(value)]));
    for (const input of timingForm.querySelectorAll("input")) input.setAttribute("aria-invalid", "false");
    timingSave = owner; syncTimingControls();
    void (async () => {
      try {
        await refresh(); requireOwner(owner);
        await deps.request("/settings", { method: "POST", body: JSON.stringify({ assistant: values }) }, owner.machine);
        if (ownerIsCurrent(owner)) timingStatus("Routine timing saved.", "success");
      }
      catch (e) {
        if (e instanceof FocusHomeChanged) { timingStatus(e.message, "error"); await showHomeChanged(e.message); return; }
        if (!ownerIsCurrent(owner)) return;
        const data = (e as { data?: { field?: string; expected?: string } }).data;
        const input = data?.field ? timingForm.elements.namedItem(data.field) as HTMLInputElement | null : null;
        input?.setAttribute("aria-invalid", "true");
        const label = input?.closest("label")?.textContent?.trim();
        timingStatus(label && data?.expected ? `${label} must be ${data.expected}` : e instanceof Error ? e.message : "Could not save routine timing.", "error");
      } finally { if (timingSave === owner) timingSave = undefined; syncTimingControls(); }
    })();
  });
  function renderHomePicker() {
    const select = document.getElementById("assistant-setting-home-select") as HTMLSelectElement | null;
    if (!select) return;
    select.disabled = busy || homeChanging || !localOwner;
    if (!localOwner || homeChanging) return;
    const self = deps.localMachineName();
    const choices = new Map([[localOwner.installationId, { id: localOwner.installationId, name: self === "this machine" ? self : `${self} (this machine)`, online: true }]]);
    for (const peer of deps.homeMachines()) if (!choices.has(peer.id)) choices.set(peer.id, peer);
    if (!choices.has(localOwner.home)) choices.set(localOwner.home, { id: localOwner.home, name: localOwner.home, online: false });
    const options = [...choices.values()].map(choice => `<option value="${escAttr(choice.id)}"${choice.online ? "" : ' disabled=""'} title="${escAttr(choice.id)}">${esc(choice.name)}${choice.online ? "" : " (offline)"}</option>`).join("");
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = localOwner.home;
  }
  document.getElementById("assistant-setting-home-select")?.addEventListener("change", event => {
    const select = event.target as HTMLSelectElement;
    if (!localOwner || busy || homeChanging) return;
    const chosen = select.value;
    const name = select.selectedOptions[0]!.textContent;
    homeChanging = true;
    select.disabled = true;
    void run(async () => {
      if (!await showAppDialog({ title: "Change home machine", message: `The focus document and assistant live on ${name}. This machine will read and write focus there. Disable this machine's assistant before moving away. Changing home does not enable an assistant.`, confirmLabel: "Change home", cancelLabel: "Cancel" })) return;
      const saved = await deps.request<Pick<FocusResponse, "home" | "installationId" | "local">>("/focus/home", { method: "POST", body: JSON.stringify({ home: chosen === localOwner!.installationId ? null : chosen }) });
      acceptOwner(saved);
      focus = undefined; answered = false; machine = ""; terminalOwner = "rejected";
      deps.terminalTarget(null);
      try { localStorage.removeItem(cacheKey); } catch { /* storage unavailable */ }
      await flight; // Discard any old-owner poll before fetching the new owner.
      await refresh();
      if (focusUnavailable) throw transportFailure ? new TypeError(error) : new Error(error);
      await loadTiming();
    }).finally(() => { homeChanging = false; render(); });
  });
  function talk() { const target = terminalTarget(); if (target && !deps.expandTerminal()) deps.open(target.session, target.machine); }
  async function showHomeChanged(message: string) {
    try { await showAppDialog({ title: "Home changed", message, confirmLabel: "Close", cancelLabel: null }); }
    catch (dialogError) { console.warn("Could not show the home-change notice", dialogError); }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try { await action(); error = ""; } catch (e) {
      transportFailure = isTransportFailure(e);
      error = e instanceof Error ? e.message : "focus action failed";
      if (e instanceof FocusHomeChanged) await showHomeChanged(error);
    }
    finally { busy = false; render(); }
  }
  let pointerPressed = false;
  let replyBlurPending = false;
  function flushReplyBlur() {
    if (!replyBlurPending || pointerPressed) return;
    replyBlurPending = false;
    // Native focus has settled; swap restores its destination by data-focus-key.
    render();
  }
  document.addEventListener("pointerdown", () => { pointerPressed = true; }, true);
  const finishPointer = () => {
    pointerPressed = false;
    // Do not replace a pressed control before its click has been dispatched.
    if (replyBlurPending) setTimeout(flushReplyBlur, 0);
  };
  document.addEventListener("pointerup", finishPointer, true);
  document.addEventListener("pointercancel", finishPointer, true);
  window.addEventListener("blur", finishPointer);
  for (const id of ["dashboard-focus", "assistant-content", "sidebar-assistant"]) {
    const host = document.getElementById(id)!;
    host.addEventListener("input", event => {
      const field = event.target;
      if (!(field instanceof HTMLTextAreaElement) || !field.dataset.focusReply || field.readOnly) return;
      const key = field.dataset.focusReply;
      const action = renderedActions.get(key);
      if (!action || action.kind !== "reply") return;
      drafts.set(key, field.value);
      syncReplyControls();
    });
    host.addEventListener("compositionstart", event => {
      if (event.target instanceof HTMLTextAreaElement && event.target.dataset.focusReply) composingReply = event.target;
    });
    host.addEventListener("compositionend", event => {
      if (event.target !== composingReply) return;
      composingReply = null;
    });
    host.addEventListener("focusout", event => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.dataset.focusReply) return;
      replyBlurPending = true;
      setTimeout(flushReplyBlur, 0);
    });
    host.addEventListener("keydown", event => {
      if (event.target instanceof HTMLTextAreaElement && event.target.dataset.focusReply && event.key === "Enter" && !event.isComposing) event.preventDefault();
    });
    host.addEventListener("paste", event => {
      const field = event.target;
      if (!(field instanceof HTMLTextAreaElement) || !field.dataset.focusReply || field.readOnly || !event.clipboardData) return;
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain").replace(/\r\n|[\r\n]/g, " ");
      const available = FOCUS_REPLY_MAX_LENGTH - (field.value.length - (field.selectionEnd - field.selectionStart));
      field.setRangeText(text.slice(0, available), field.selectionStart, field.selectionEnd, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    host.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!target) return;
      const action = target.dataset.focusAction;
      if (action === "toggle-dashboard") {
        (id === "sidebar-assistant" ? desktopDisclosure : dashboardDisclosure()).toggle(dashboardAttention); render();
        return;
      }
      if (action === "view") deps.show("assistant");
      if (action === "settings") deps.show("settings");
      if (action === "more-next") {
        const firstNew = isDesktop() ? 5 : 3;
        showAllNext = true;
        render();
        host.querySelectorAll<HTMLElement>(".focus-next > li > details > summary")[firstNew]?.focus();
        return;
      }
      const expand = target.dataset.focusExpand;
      if (expand) {
        openCard(expand);
        render();
        host.querySelector<HTMLElement>(`details[data-focus-card="${CSS.escape(expand)}"] > summary`)?.focus();
        return;
      }
      if (action === "talk") { talk(); return; }
      if (locked()) return;
      if (target.dataset.focusReset) {
        const action = currentAction(target.dataset.focusReset);
        if (action?.kind === "reply") { drafts.delete(action.key); render(); }
        return;
      }
      if (action === "catch-up") void run(async () => {
        const owner = captureOwner();
        const next = await deps.request<RoutineStatus>("/focus/catch-up", { method: "POST" }, owner.machine);
        requireOwner(owner, OLD_HOME_COMPLETED);
        if (focus) focus.routines = next;
      });
      if (action === "day-note") void run(readDayNote);
      if (action === "seen-take" && target.dataset.focusAt) {
        const at = target.dataset.focusAt;
        void run(() => write({ type: "seen-take", at }));
      }
      if (target.dataset.focusUndo) void run(() => write({ type: "undo", id: target.dataset.focusUndo! }));
      if (target.dataset.focusComplete) void run(() => write({ type: "done", id: target.dataset.focusComplete! }));
      if (target.dataset.focusStart) {
        if (sessionLocked()) return;
        const intention = doc().intentions.find(i => i.id === target.dataset.focusStart && !i.done);
        if (intention && !linkedFocusSessions(intention, sessions()).length) deps.start(intention);
        return;
      }
      const rowAction = target.dataset.focusNext ?? target.dataset.focusMarkDone;
      if (rowAction !== undefined) {
        if (sessionLocked()) return;
        const action = currentAction(rowAction);
        if (!action) return;
        const { row, kind } = action;
        if (kind === "reply") {
          const text = drafts.get(rowAction) ?? row.triage?.suggestion ?? "";
          if (!text.trim() || text.length > FOCUS_REPLY_MAX_LENGTH || /[\r\n]/.test(text)) return;
          void run(() => sendReply(row, rowAction, text));
          return;
        }
        if (kind === "seen" && row.session) { void run(() => deps.acknowledge(row.session!)); return; }
        if (kind === "done") { void run(() => write({ type: "done", id: row.triage!.doneIntention! })); return; }
        if (kind === "open" && row.session) deps.open(row.session.name, row.session.machineUrl);
        else if (kind === "start" && row.intention) deps.start(row.intention);
        else if (row.intention) { openCard(`start:${row.intention.id}`); render(); }
      }
      if (target.dataset.focusSession) {
        if (sessionLocked()) return;
        const session = sessions().find(s => s.id === target.dataset.focusSession);
        if (session) deps.open(session.name, session.machineUrl);
      }
    });
    // toggle does not bubble: listen in the capture phase.
    host.addEventListener("toggle", event => {
      const key = (event.target as HTMLElement).dataset?.focusCard;
      if (!key) return;
      if (!(event.target as HTMLDetailsElement).open) {
        openCards.delete(key);
        // Closing reveals chips skipped while hidden, possibly after a resize or data update.
        if (fitChips()) render();
        return;
      }
      openCard(key);
      const session = renderedSessions.get(key);
      if (session && !contextTried.has(contextKey(session))) void loadContext(session);
    }, true);
    host.addEventListener("change", event => {
      const target = event.target as HTMLInputElement;
      if (target.dataset.focusDone) void run(() => write({ type: target.checked ? "done" : "undo", id: target.dataset.focusDone! }));
    });
    host.addEventListener("submit", event => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const input = form.querySelector<HTMLInputElement>("input")!;
      const text = input.value.trim();
      if (!text) return;
      void run(async () => {
        await write({ type: "add", intention: { id: crypto.randomUUID(), title: text } });
        input.value = "";
      });
    });
  }
  document.getElementById("assistant-back")!.onclick = () => deps.show("sessions");
  document.getElementById("assistant-terminal-focus")!.onclick = () => deps.show("assistant");
  document.getElementById("assistant-setting-open")!.onclick = () => deps.show("assistant");
  document.getElementById("assistant-setting-toggle")!.onclick = () => { void run(async () => {
    const owner = captureOwner();
    const enabled = !focus?.assistant?.enabled;
    if (!await deps.confirm(enabled)) return;
    await refresh(); requireOwner(owner);
    const assistant = await deps.request<AssistantStatus>("/focus/assistant", { method: "POST", body: JSON.stringify({ enabled, loginConfirmed: enabled }) }, owner.machine);
    requireOwner(owner, OLD_HOME_COMPLETED);
    if (focus) focus.assistant = assistant;
    await refresh(); requireOwner(owner);
    // One enable: the assistant opens right away so its first run (and anything pi asks) is in view.
    if (enabled) deps.show("assistant");
  }); };
  let resizeFrame: number | undefined;
  window.addEventListener("resize", () => {
    if (resizeFrame !== undefined) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; render(); });
  });
  render();
  return { refresh, render, loadTiming,
    setSidebarOwner(owns: boolean) { sidebarOwnsChooser = owns; updateSidebarVisibility(); },
    captureStart: (intentionId: string): FocusSessionStart => {
      const owner = captureOwner();
      const start = { intentionId, home: owner.home };
      startOwners.set(start, owner);
      return start;
    },
    linkStartedSession: async (start: FocusSessionStart, session: StartedFocusSession) => {
      const owner = startOwners.get(start);
      if (!owner) throw new FocusHomeChanged();
      await write(() => linkStartedFocusSession(doc(), start.intentionId, session), owner);
      render();
    },
    enabled: () => !!focus?.assistant?.enabled,
    isAssistant: (name: string, key: string) => name === focus?.assistant?.session && key === machine };
}
