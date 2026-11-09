import { linkStartedFocusSession, type FocusSessionStart, type StartedFocusSession } from "../src/focus-start";
import { esc, escAttr, isDesktop } from "./app-state";
import { rankFocus, stoppedUnseen, linkedFocusSessions, doneToday, focusSessionLabel, focusActionVerb, type FocusAction, type FocusSession } from "../src/focus-ranking";
import { emptyFocus, isFocusDocument, type FocusDocument, type FocusIntention, type FocusOp } from "../src/focus-contract";
import type { AssistantTiming } from "../src/focus-scheduler";
import type { AssistantTerminalTarget } from "./assistant-terminal";
import { showAppDialog } from "./app-dialog";
import { isRequestTimeout } from "./fetch-timeout";
import { AGENT_CONTEXT_DOCUMENT_PATH, agentContextEnabled, extensionUnavailable, summarizeAgentContext } from "../src/focus-context";
interface AssistantStatus { enabled: boolean; folder: string; state: string; session?: string; sessionId?: string; queued: number; error?: string; unavailableReason?: string }
interface RoutineStatus { catchingUp: { machines: number; since: string | null; unconfirmed?: true } | null; yesterday?: { date: string; note: boolean; endsAt: string }; stale: { since: string } | null; unreachable: { name: string; since: string | null }[]; surfaced: { sends: number } | null; notice?: string; error?: string }
interface FocusResponse { home: string; installationId: string; local: boolean; document: FocusDocument | null; revision: number; assistant?: AssistantStatus; routines?: RoutineStatus }
interface Machine { key: string; name: string }
class FocusOwnershipError extends Error {}
const isTransportFailure = (error: unknown) => !(error instanceof FocusOwnershipError)
  && (error instanceof TypeError || isRequestTimeout(error) || navigator.onLine === false);
export function createAssistantView(deps: {
  request: <T>(path: string, init?: RequestInit, machine?: string, interactive?: boolean) => Promise<T>;
  homeMachine: (id: string) => Machine | undefined;
  localMachineName: () => string;
  sessions: () => FocusSession[];
  /** Verify a cached assistant incarnation against the current owning session list. */
  terminalSessionAvailable: (target: AssistantTerminalTarget) => boolean;
  terminalTarget: (target: AssistantTerminalTarget | null, unavailableMessage?: string) => void;
  /** False means the local session projection is unavailable, not that every session stopped. */
  sessionsAvailable: () => boolean;
  /** A completed local session fetch failed; the initial pending fetch is not an outage. */
  sessionsUnavailable: () => boolean;
  /** Unavailable peers may retain history; retired/replaced installations may not. */
  sessionMachineKnown: (identity: string) => boolean;
  open: (name: string, machine?: string) => void;
  start: (intention: FocusIntention) => void;
  show: (view: string) => void;
  confirm: (enabled: boolean) => Promise<boolean>;
}) {
  let focus: FocusResponse | undefined;
  let machine = "";
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
  const pageNextCap = () => showAllNext ? Infinity : 5;
  let wasEnabled = false;
  let sidebarOwnsChooser = false;
  function updateSidebarVisibility() {
    const tile = document.getElementById("sidebar-assistant");
    if (tile) tile.hidden = !sidebarOwnsChooser || !focus?.assistant?.enabled;
  }
  const cacheKey = "wolfpack-focus-cache";
  try { const cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && (cached.document === null || isFocusDocument(cached.document))) { focus = cached; if (cached.terminalOwner === "rejected") terminalOwner = "rejected"; if (typeof cached.machine === "string") machine = cached.machine; if (typeof cached.homeName === "string") homeName = cached.homeName; } } catch { /* no valid cached focus */ }
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
    if (deps.sessionsAvailable()) lastSessions = deps.sessions();
    lastSessions = lastSessions.filter(session => !session.machineUrl || deps.sessionMachineKnown(session.machineUrl));
    return lastSessions;
  };
  const nextRows = (cap: number) => !deps.sessionsAvailable() && !lastSessions.length ? [] : rankFocus(doc(), sessions(), cap);
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
  function replace(id: string, html: string) {
    const host = document.getElementById(id);
    if (!host) return;
    if (host.innerHTML !== html) swap(host, html);
    // what each card shows now is what this render meant (a skipped swap means the dom already matched)
    for (const el of host.querySelectorAll<HTMLDetailsElement>("details[data-focus-card]")) renderedOpen.set(el, el.open);
  }
  function restoreFocus(target: HTMLElement | null): boolean {
    if (!target?.isConnected || !target.closest(".view.visible") || target.closest("[inert], [hidden], [aria-hidden='true']") || target.matches(":disabled") || !target.getClientRects().length || getComputedStyle(target).visibility !== "visible") return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }
  function swap(host: HTMLElement, html: string) {
    const active = host.contains(document.activeElement) ? document.activeElement as HTMLInputElement : null;
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
  function rowContext(intention?: FocusIntention, session?: FocusSession) {
    const all = sessions();
    const local = deps.localMachineName();
    const manyMachines = new Set(all.map(s => s.machine)).size > 1;
    const linked = session ? [session] : linkedFocusSessions(intention!, all);
    const targets = linked.length ? linked : [{ cwd: intention?.project, machine: intention?.machine, machineUrl: undefined }];
    const labels = [...new Set(targets.map(s => [project(s.cwd), s.machine && (manyMachines || s.machineUrl || s.machine !== local) ? esc(s.machine) : ""].filter(Boolean).join(" · ")).filter(Boolean))];
    const caption = [session && intention ? esc(intention.title) : "", labels.join(", ")].filter(Boolean).join(" · ");
    return caption ? `<small class="focus-for">${caption}</small>` : "";
  }
  // `open=""` is how innerHTML serializes the attribute, so an unchanged render still compares equal in replace().
  const card = (key: string, summary: string, body: string, extra = "") => `<details class="focus-card" data-focus-card="${escAttr(key)}"${openCards.has(key) ? ' open=""' : ""}><summary data-focus-key="${escAttr(`card:${key}`)}">${summary}</summary><dl class="focus-card-body">${body}</dl>${extra}</details>`;
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
    const fields = field("goal", esc(context.goal ?? "")) + field("now", esc(context.now ?? ""))
      + field("needs you", context.needsYou.length ? `<ul class="focus-needs">${context.needsYou.slice(0, 5).map(need).join("")}</ul>${more}` : "")
      + field("next", context.nextSteps.length ? `<ol>${context.nextSteps.map(step => `<li>${esc(step.text)}${step.owner ? ` <span class="focus-owner">${step.owner}</span>` : ""}</li>`).join("")}</ol>` : "")
      + field("need to know", context.needToKnow.length ? `<ul>${context.needToKnow.map(text => `<li>${esc(text)}</li>`).join("")}</ul>` : "");
    const fresh = [context.freshness, context.updatedAt && `updated ${age(context.updatedAt)}`].filter(Boolean).join(" · ");
    return `<div class="focus-context"><p class="focus-context-label">context</p>${fields ? `<dl class="focus-card-body">${fields}</dl>` : ""}${fresh ? `<p class="focus-context-note">${esc(fresh)}</p>` : ""}</div>`;
  }
  function sessionBody(row: FocusAction, session: FocusSession) {
    const stopped = stoppedUnseen(session);
    return field("machine", esc(session.machine ?? "")) + field("project", project(session.cwd))
      + field("state", stopped ? `stopped${session.changedAt ? ` · ${age(session.changedAt)}` : ""}` : `${esc(focusSessionLabel(session))}${session.changedAt ? ` · since ${age(session.changedAt)}` : ""}`)
      + field("last line", session.lastLine ? `<code>${esc(session.lastLine)}</code>` : "") + field("why here", esc(row.reason)) + field("for", esc(row.intention?.title ?? ""));
  }
  function intentionBody(intention: FocusIntention, cardKey: string, reason?: string) {
    const linked = linkedFocusSessions(intention, sessions());
    return field("sessions", linked.length ? `<span class="focus-chips focus-session-chips">${linked.map(session => sessionChip(session, `body:${cardKey}`)).join("")}</span>` : "none yet")
      + field("project", project(intention.project)) + field("machine", esc(intention.machine ?? "")) + field("added", stamp(intention.createdAt))
      + field("done", intention.done && intention.doneAt ? stamp(intention.doneAt) : "") + field("why here", esc(reason ?? ""));
  }
  // One wording for a next row: the row itself and the sidebar tile's "next" line.
  const nextTitle = (row: FocusAction) => row.session
    ? `${row.session.name} ${focusSessionLabel(row.session)}`
    : `start “${row.intention!.title}”`;
  function nextHtml(cap: number, expanded = false) {
    const rows = nextRows(cap);
    if (!rows.length) return `<p class="focus-empty">${doc().intentions.length && doc().intentions.every(i => i.done) ? "all intentions done — tell the assistant what's next" : "nothing waiting"}</p>`;
    return `<ol class="focus-next" aria-label="Next actions">${rows.map((row, index) => {
      const finished = row.session?.state === "done" && !stoppedUnseen(row.session);
      const title = nextTitle(row);
      const verb = focusActionVerb(row);
      // A start row and the same intention's today card are separate cards: `start:` here, `intention:` in today.
      const key = row.session ? `session:${row.session.id}` : `start:${row.intention!.id}`;
      if (row.session) renderedSessions.set(key, row.session);
      const action = `<button type="button" class="focus-action"${sessionLocked() ? " disabled" : ""} data-focus-next="${index}" data-focus-key="${escAttr(`act:${key}`)}" aria-label="${escAttr(row.session ? `${verb} ${title}` : title)}">${verb}<span aria-hidden="true"> ›</span></button>`;
      const summary = `<span class="focus-rank">${index + 1}</span>${dot(row.session?.state ?? "idle")}<span class="focus-title">${esc(title)}${row.session?.changedAt ? `<small> · ${finished ? clock(row.session.changedAt) : age(row.session.changedAt)}</small>` : ""}</span>${rowContext(row.intention, row.session)}`;
      return `<li${index >= 3 && !expanded ? ' class="focus-extra"' : ""}>${card(key, summary, row.session ? sessionBody(row, row.session) : intentionBody(row.intention!, key, row.reason), row.session ? contextHtml(row.session) : "")}${action}</li>`;
    }).join("")}</ol>`;
  }
  function sessionChip(session: FocusSession, key: string, hidden = false) {
    return `<button type="button"${hidden ? ' class="focus-chip-extra"' : ""}${sessionLocked() ? " disabled" : ""} data-focus-key="${escAttr(`${key}:${session.id}`)}" data-focus-session="${escAttr(session.id)}" title="${escAttr(session.name)}">${dot(session.state)}<span class="focus-chip-name">${esc(session.name)}</span></button>`;
  }
  const compactChips = new Map<string, { count: number; width: number }>();
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
      const previous = compactChips.get(chips.dataset.focusChips!);
      if (previous?.count !== count || previous.width !== width) {
        compactChips.set(chips.dataset.focusChips!, { count, width });
        changed = true;
      }
    }
    return changed;
  }
  function todayHtml(items: FocusIntention[]) {
    return `<ul class="focus-today" aria-label="Intentions">${items.map(i => `<li style="--focus-chips-width:${compactChips.get(i.id)?.width ?? 0}px"${i.done ? ' class="done"' : ""}><label class="focus-check"><input type="checkbox" data-focus-done="${escAttr(i.id)}" data-focus-key="${escAttr(i.id)}" aria-label="Done: ${escAttr(i.title)}"${i.done ? " checked" : ""}${locked() ? " disabled" : ""}></label>${card(`intention:${i.id}`, `<span class="focus-title">${esc(i.title)}${rowContext(i)}</span>`, intentionBody(i, `intention:${i.id}`))}${chipsHtml(i)}</li>`).join("")}</ul>`;
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
    const current = doc();
    for (const id of compactChips.keys()) if (!current.intentions.some(intention => intention.id === id && linkedFocusSessions(intention, sessions()).length > 0)) compactChips.delete(id);
    const enabled = !!focus?.assistant?.enabled;
    const state = status();
    // The unavailable header already names the outage; keep transport diagnostics in settings.
    const assistantError = terminalUnavailable() ? "" : focus?.assistant?.error;
    const next = nextRows(pageNextCap());
    const nextCount = nextRows(Infinity).length;
    const visibleNext = isDesktop() ? 5 : 3;
    const moreNext = !showAllNext && nextCount > visibleNext ? `<p>${button("more-next", `show ${nextCount - visibleNext} more`)}</p>` : "";
    const summary = `${current.intentions.filter(i => i.done).length} of ${current.intentions.length} done`;
    // "know when items are done": today's ticks and finishes carry a time; the rest of the list stays as it was.
    const done = doneToday(current, sessions(), Date.now(), doneDay);
    const latest = done[0] && ` · ${done[0].kind === "intention" ? `✓ ${esc(done[0].intention.title)}` : `${esc(done[0].session.name)} finished`} ${clock(done[0].at)}`;
    const doneHtml = done.length ? `<h2>done today <small>${plural(done.filter(i => i.kind === "intention").length, "intention")} · ${plural(done.filter(i => i.kind === "session").length, "session")}</small></h2><ul class="focus-done" aria-label="Done today">${done.map(i => `<li><span class="focus-time">${clock(i.at)}</span>${i.kind === "intention"
      ? `<span class="focus-what">✓ ${esc(i.intention.title)}</span><button type="button" data-focus-undo="${escAttr(i.intention.id)}" data-focus-key="${escAttr(`undo:${i.intention.id}`)}" aria-label="Undo done: ${escAttr(i.intention.title)}"${locked() ? " disabled" : ""}>undo</button>`
      : `<span class="focus-what"><b>${esc(i.session.name)}</b> finished · for ${esc(i.intention.title)}</span><button type="button" data-focus-session="${escAttr(i.session.id)}" data-focus-key="${escAttr(`done:${i.intention.id}:${i.session.id}`)}"${sessionLocked() ? " disabled" : ""}>open ›</button>`}</li>`).join("")}</ul>` : "";
    const open = current.intentions.filter(i => !(i.done && i.doneAt && doneDay(i.doneAt) === localDay(Date.now())));
    const r = routines();
    const catching = r?.catchingUp;
    // Every state names the user's move: answer, catch up now, look at its terminal; never only what the system is doing.
    const info = offline() ? `focus from ${current.updatedAt ? when(current.updatedAt) : "cache"} · ${homeName} offline · read-only`
      : focusUnavailable ? "focus unavailable · read-only · details in settings"
      : terminalUnavailable() ? "sessions unavailable · focus is saved here"
      : state === "needs you" ? "needs you · answer"
      : r?.surfaced ? `has not confirmed reading activity · sent ${r.surfaced.sends} times`
      : catching?.unconfirmed ? `reading activity · ${DELIVERY_UNCONFIRMED}`
      : catching ? `reading activity${catching.since ? ` since ${when(catching.since)}` : ""} · ${plural(catching.machines, "machine")}`
      : r?.stale ? `quiet since ${when(r.stale.since)}` : `${state} · ${freshness()}`;
    const nudgeDay = current.nudge && localDay(Date.parse(current.nudge.updatedAt));
    const nudge = current.nudge?.text ? `<p class="focus-nudge${catching ? " from" : ""}">${esc(current.nudge.text)}${catching && nudgeDay !== localDay(Date.now()) ? ` <small>from ${dayName(nudgeDay!)}</small>` : ""}</p>` : "";
    const catchUp = button("catch-up", "catch up now", "catch up now", !!terminalUnavailable());
    const noteItems = [...(r ? [...r.unreachable.map(m => esc(`${m.name} not reached ${m.since ? `since ${when(m.since)}` : "yet"} · its day is reviewed when it is back`)), ...(r.surfaced ? [`${r.stale ? `quiet since ${when(r.stale.since)} · ` : ""}look at its terminal, then ${catchUp}`] : []), ...(r.stale && !r.surfaced ? [catchUp] : []), ...[r.notice, r.error].filter(Boolean).map(t => esc(t!))] : []), ...(!focusUnavailable && enabled && assistantError ? [esc(assistantError)] : [])].map(n => `<span>${n}</span>`).join("");
    const notes = noteItems ? `<p class="focus-notes">${noteItems}</p>` : "";
    const summaryDay = current.daySummary;
    // A day note stays listed until it is marked read after that activity day ended (its turn at the
    // fallback time, from the home server; calendar midnight when routines are unavailable). seenDayNoteAt is shared across devices.
    const noteDay = r?.yesterday?.date === summaryDay?.date ? r?.yesterday : undefined;
    const dayEnd = summaryDay && (noteDay ? Date.parse(noteDay.endsAt) : new Date(`${summaryDay.date}T00:00`).getTime() + 864e5);
    const yesterday = summaryDay && !(current.seenDayNoteAt && Date.parse(current.seenDayNoteAt) >= dayEnd!)
      ? `<div class="focus-yesterday"><h2>${dayName(summaryDay.date)}</h2><span>${summaryDay.done} done · ${summaryDay.carried} carried over · ${summaryDay.questions} question${summaryDay.questions === 1 ? "" : "s"}</span>${button("day-note", "read ›", `Read day note for ${summaryDay.date}`, noteDay?.note === false)}</div>` : "";
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
    const tileStatus = tileState ?? `${nextCount} next`;
    if (tile) {
      updateSidebarVisibility();
      // The tile's tone drives its glow: amber when the user's move is due, a pulse while it reads or works, red offline.
      tile.dataset.tone = focusUnavailable || terminalUnavailable() || state === "failed" ? "failed" : state === "needs you" || r?.surfaced ? "attn" : catching || state === "working" ? "busy" : "rest";
      const countedNext = tileState === null;
      const upNext = next[0] ? `<i aria-hidden="true">next</i> ${countedNext ? "" : '<span class="visually-hidden">next:</span> '}${esc(nextTitle(next[0]))}` : esc(current.nudge?.text || (focus?.document ? "nothing queued" : "set your focus"));
      tile.innerHTML = `<span class="assistant-tile-head">${TILE_MARK}<b>assistant<span class="visually-hidden">,</span></b><span class="assistant-tile-state">${tone}${tileStatus}${countedNext && next[0] ? '<span class="visually-hidden">:</span>' : ""}</span></span> <span class="assistant-tile-next">${upNext}</span>`;
      tile.title = current.nudge?.text ?? info;
      // The visible content (name, status, next) is the accessible name: an aria-label would hide what is shown (axe label-content-name-mismatch).
      tile.removeAttribute("aria-label");
    }
    const block = document.getElementById("dashboard-focus");
    if (block) block.hidden = !enabled;
    const attn = state === "needs you" ? `<button type="button" class="focus-attn" data-focus-action="talk" data-focus-key="action:attn">${dot(state)} ${esc(info)} ›</button>` : "";
    replace("dashboard-focus", !enabled ? "" : `<div class="focus-header">${attn || `${tone}${button("view", "assistant", "Open assistant", false, "view-title")}<small${catching ? ' class="focus-spin"' : ""}>${esc(info)}</small>`}${sessionNotice}${button("view", "open assistant ›", "Open assistant page")}</div>${notes}${nudge}${focus?.document ? nextHtml(3) + `<small>${nextCount} next${current.intentions.length ? ` · today · ${summary}${latest ?? ""}` : ""}</small>` : `<p>Set your focus</p>${addForm(true)}`}${error && !focusUnavailable ? `<p role="status">${esc(error)}</p>` : ""}`);
    replace("assistant-content", !enabled ? "" : `<div class="focus-header">${attn || `<span title="${escAttr(info)}"${catching ? ' class="focus-spin"' : ""}>${tone} ${esc(info)}</span>`}${sessionNotice}<span class="focus-header-actions"><button type="button" class="focus-talk" data-focus-action="talk" data-focus-key="action:talk" aria-label="Talk to assistant"${terminalUnavailable() ? ` title="${escAttr(terminalUnavailable()!)}"` : ""}${!terminalTarget() ? " disabled" : ""}>talk<span aria-hidden="true"> ›</span></button>${button("settings", "settings", "Assistant settings")}</span></div>${notes}${nudge}<h2>next <small>${nextCount}</small></h2>${nextHtml(pageNextCap(), showAllNext)}${moreNext}${current.intentions.length && next.length ? `<details><summary>why this order</summary><ol>${next.map(r => `<li>${esc(r.reason)}</li>`).join("")}</ol></details>` : ""}${current.intentions.length ? `<h2>today <small>${summary}</small></h2>${todayHtml(open)}` : ""}${addForm(!focus?.document)}<small>reorder, reword or drop: tell the assistant</small>${doneHtml}${yesterday}`);
    const live = document.getElementById("focus-status");
    if (live) live.textContent = focusUnavailable ? "" : error || assistantError || (focus?.assistant?.queued ? `${focus.assistant.queued} queued${terminalUnavailable() ? " · sends when the broker is back" : ""}` : notice);
    const setting = document.getElementById("assistant-setting-status");
    if (setting) setting.textContent = enabled ? `on · ${info}` : "off";
    const settingError = document.getElementById("assistant-setting-error");
    if (settingError) settingError.textContent = offline() ? "" : error || focus?.assistant?.error || "";
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
      try {
        let response = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, undefined, false);
        const home = response.local ? { key: "", name: "this machine" } : deps.homeMachine(response.home);
        homeName = home?.name ?? (focus?.home === response.home ? homeName : "sgt");
        if (focus && focus.home !== response.home) focus = { ...response, document: null };
        machine = home?.key ?? "";
        if (!response.local) {
          if (!home) { if (focus?.home !== response.home) focus = { ...response, document: null }; throw new TypeError(`${homeName} offline`); }
          const remote = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, machine, false);
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
      } catch (e) {
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
  async function write(op: FocusOp | (() => FocusOp)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (focusUnavailable) throw new Error("focus is unavailable; changes were not saved");
      if (!answered) throw new Error("focus is still loading; changes were not saved");
      try {
        const saved = await deps.request<FocusResponse>("/focus", { method: "POST", body: JSON.stringify({ expectedRevision: doc().revision, ops: [typeof op === "function" ? op() : op] }) }, machine);
        focus = { ...saved, assistant: focus?.assistant };
        writes++;
        cache(focus);
        announce("focus updated");
        return;
      } catch (e) { if (attempt || (e as { status?: number }).status !== 409) throw e; await refresh(); }
    }
  }
  async function readDayNote() {
    const date = doc().daySummary?.date;
    if (!date) return;
    const note = await deps.request<{ markdown: string }>(`/focus/day-note?date=${date}`, undefined, machine);
    if (await showAppDialog({ title: `Day note ${date}`, message: note.markdown, scroll: true, confirmLabel: "Mark read", cancelLabel: "Close" })) await write({ type: "seen-day-note", at: new Date().toISOString() });
  }
  const timingForm = document.getElementById("assistant-timing") as HTMLFormElement | null;
  const timingStatus = (text: string, state: string) => { const el = document.getElementById("assistant-timing-status"); if (el) { el.textContent = text; el.dataset.state = state; } };
  async function loadTiming() {
    await refresh();
    if (!timingForm) return;
    try {
      const timing = (await deps.request<{ settings: { assistant: AssistantTiming } }>("/settings", undefined, machine, false)).settings.assistant;
      for (const [key, value] of Object.entries(timing)) (timingForm.elements.namedItem(key) as HTMLInputElement).value = String(value);
      timingStatus(`Routine timing on ${homeName}.`, "idle");
    } catch { timingStatus(`Could not load routine timing from ${homeName}.`, "error"); }
  }
  // The home server validates; a field error is worded with that field's own label and marks the input.
  timingForm?.addEventListener("submit", event => {
    event.preventDefault();
    const values = Object.fromEntries([...new FormData(timingForm)].map(([key, value]) => [key, key === "fallbackTime" ? String(value) : Number(value)]));
    for (const input of timingForm.querySelectorAll("input")) input.setAttribute("aria-invalid", "false");
    void (async () => {
      try { await deps.request("/settings", { method: "POST", body: JSON.stringify({ assistant: values }) }, machine); timingStatus("Routine timing saved.", "success"); }
      catch (e) {
        const data = (e as { data?: { field?: string; expected?: string } }).data;
        const input = data?.field ? timingForm.elements.namedItem(data.field) as HTMLInputElement | null : null;
        input?.setAttribute("aria-invalid", "true");
        const label = input?.closest("label")?.textContent?.trim();
        timingStatus(label && data?.expected ? `${label} must be ${data.expected}` : e instanceof Error ? e.message : "Could not save routine timing.", "error");
      }
    })();
  });
  function talk() { const target = terminalTarget(); if (target) deps.open(target.session, target.machine); }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try { await action(); error = ""; } catch (e) {
      transportFailure = isTransportFailure(e);
      error = e instanceof Error ? e.message : "focus action failed";
    }
    finally { busy = false; render(); }
  }
  for (const id of ["dashboard-focus", "assistant-content"]) {
    const host = document.getElementById(id)!;
    host.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!target) return;
      const action = target.dataset.focusAction;
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
      if (action === "catch-up") void run(async () => { const next = await deps.request<RoutineStatus>("/focus/catch-up", { method: "POST" }, machine); if (focus) focus.routines = next; });
      if (action === "day-note") void run(readDayNote);
      if (target.dataset.focusUndo) void run(() => write({ type: "undo", id: target.dataset.focusUndo! }));
      if (target.dataset.focusNext !== undefined) {
        if (sessionLocked()) return;
        const row = nextRows(id === "dashboard-focus" ? 3 : pageNextCap())[Number(target.dataset.focusNext)];
        if (row?.session) deps.open(row.session.name, row.session.machineUrl); else if (row?.intention) deps.start(row.intention);
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
  document.getElementById("sidebar-assistant")!.onclick = () => deps.show("assistant");
  document.getElementById("assistant-back")!.onclick = () => deps.show("sessions");
  document.getElementById("assistant-terminal-focus")!.onclick = () => deps.show("assistant");
  document.getElementById("assistant-setting-open")!.onclick = () => deps.show("assistant");
  document.getElementById("assistant-setting-toggle")!.onclick = () => { void run(async () => {
    const enabled = !focus?.assistant?.enabled;
    if (!await deps.confirm(enabled)) return;
    const assistant = await deps.request<AssistantStatus>("/focus/assistant", { method: "POST", body: JSON.stringify({ enabled, loginConfirmed: enabled }) }, machine);
    if (focus) focus.assistant = assistant;
    await refresh();
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
    captureStart: (intentionId: string): FocusSessionStart => ({ intentionId, home: focus?.home ?? "" }),
    linkStartedSession: async (start: FocusSessionStart, session: StartedFocusSession) => {
      await write(() => {
        if (start.home !== focus?.home) throw new Error("focus home changed while creating the session");
        return linkStartedFocusSession(doc(), start.intentionId, session);
      });
      render();
    },
    enabled: () => !!focus?.assistant?.enabled,
    isAssistant: (name: string, key: string) => name === focus?.assistant?.session && key === machine };
}
