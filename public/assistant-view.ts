import { linkStartedFocusSession, type FocusSessionStart, type StartedFocusSession } from "../src/focus-start";
import { esc, escAttr } from "./app-state";
import { rankFocus, linkedFocusSessions, doneToday, type FocusAction, type FocusSession } from "../src/focus-ranking";
import { emptyFocus, isFocusDocument, type FocusDocument, type FocusIntention, type FocusOp } from "../src/focus-contract";
import type { AssistantTiming } from "../src/focus-scheduler";
import { showAppDialog } from "./app-dialog";
import { focusReplyView, observePendingAsk, startPendingAsk, type PendingAsk } from "../src/focus-reply";
import { AGENT_CONTEXT_DOCUMENT_PATH, agentContextEnabled, extensionUnavailable, summarizeAgentContext } from "../src/focus-context";
interface AssistantStatus { enabled: boolean; folder: string; state: string; session?: string; sessionId?: string; queued: number; error?: string }
interface RoutineStatus { catchingUp: { machines: number; since: string | null; unconfirmed?: true } | null; yesterday?: { date: string; note: boolean; endsAt: string }; stale: { since: string } | null; unreachable: { name: string; since: string | null }[]; surfaced: { sends: number } | null; notice?: string; error?: string }
interface FocusResponse { home: string; installationId: string; local: boolean; document: FocusDocument | null; revision: number; assistant?: AssistantStatus; routines?: RoutineStatus }
interface Machine { key: string; name: string }
export function createAssistantView(deps: {
  request: <T>(path: string, init?: RequestInit, machine?: string, interactive?: boolean) => Promise<T>;
  homeMachine: (id: string) => Machine | undefined;
  sessions: () => FocusSession[];
  open: (name: string, machine?: string) => void;
  start: (intention: FocusIntention) => void;
  show: (view: string) => void;
  confirm: (enabled: boolean) => Promise<boolean>;
}) {
  let focus: FocusResponse | undefined;
  let machine = "";
  let homeName = "sgt";
  let offline = false;
  // No answer from the home yet (first paint from the cache): show the cached copy as it was, write nothing.
  let answered = false;
  // Saved writes; a poll started before one does not replace the document it saved.
  let writes = 0;
  let error = "";
  let notice = "";
  let flight: Promise<void> | undefined;
  let busy = false;
  let opened = false;
  let wasEnabled = false;
  // The last ask typed here, until the page reloads; its answer comes back as document.reply.
  let pendingAsk: PendingAsk | undefined;
  const activity = (assistant = focus?.assistant) => ({ state: assistant?.state ?? "off", queued: assistant?.queued ?? 0, error: assistant?.error, sessionId: assistant?.sessionId });
  const cacheKey = "wolfpack-focus-cache";
  try { const cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && (cached.document === null || isFocusDocument(cached.document))) { focus = cached; if (typeof cached.homeName === "string") homeName = cached.homeName; } } catch { /* no valid cached focus */ }
  const locked = () => offline || busy || !answered;
  // The cached copy carries the home's resolved name, so an offline first answer names the right machine.
  const cache = (value: FocusResponse) => { try { localStorage.setItem(cacheKey, JSON.stringify({ ...value, homeName })); } catch { /* storage unavailable; live view still works */ } };
  const doc = () => focus?.document ?? emptyFocus();
  const routines = () => offline || !focus?.assistant?.enabled ? undefined : focus.routines;
  // An error beside a live session (a dropped queue, an unverified send) is a note under the live state; "failed" is the assistant not running.
  const status = () => offline ? `${homeName} offline` : focus?.assistant?.error && !focus.assistant.session ? "failed" : focus?.assistant?.enabled ? (focus.assistant.state === "needs-input" ? "needs you" : routines()?.catchingUp ? "catching up" : focus.assistant.state) : "off";
  // `Tue 23:00`: the plan's copy for catching-up / stale / not-reached times.
  const when = (at: string) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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
  const button = (action: string, label: string, name = label, disabled = false) => `<button type="button" data-focus-action="${action}" aria-label="${escAttr(name)}"${disabled ? " disabled" : ""}>${esc(label.replace(" ›", ""))}${label.endsWith(" ›") ? '<span aria-hidden="true"> ›</span>' : ""}</button>`;
  const dot = (state: string) => `<span class="dot ${state === "needs-input" || state === "needs you" ? "yellow" : state === "working" ? "green" : state === "failed" ? "red" : "gray"}" aria-hidden="true"></span>`;
  function replace(id: string, html: string) {
    const host = document.getElementById(id);
    if (!host || host.innerHTML === html) return;
    const active = host.contains(document.activeElement) ? document.activeElement as HTMLInputElement : null;
    const key = active?.dataset.focusKey;
    const value = active?.value;
    const selection = active?.selectionStart;
    host.innerHTML = html;
    if (key) {
      const next = host.querySelector<HTMLInputElement>(`[data-focus-key="${CSS.escape(key)}"]`);
      if (next) { if (next.type !== "checkbox" && value !== undefined) next.value = value; next.focus({ preventScroll: true }); if (selection !== null && selection !== undefined && next.type === "text") next.setSelectionRange(selection, selection); }
    }
  }
  function addForm(first = false) {
    const label = first ? "What are you working on?" : "Add an intention";
    return `<form data-focus-form="add" class="focus-add"><input type="text" data-focus-key="add" aria-label="${label}" placeholder="${first ? "what are you working on?" : "add an intention…"}" maxlength="500" required${locked() ? " disabled" : ""}><button type="submit"${locked() ? " disabled" : ""}>Add</button></form>`;
  }
  // The ask's answer stays on this page: the assistant writes it with `wolfpack focus reply`; the terminal is the fallback.
  function replyHtml() {
    const view = focusReplyView(pendingAsk, doc().reply, activity(), Date.now());
    if (view.kind === "none") return "";
    const look = button("talk", "open ›", "Open the assistant's terminal", offline || !focus?.assistant?.session);
    const you = "ask" in view ? `<p class="focus-ask"><b>you</b> · ${esc(view.ask.text)}</p>` : "";
    const line = view.kind === "reply" || view.kind === "answered"
      ? `<p class="focus-answer">${esc(view.reply.text)} <small>· ${view.reply.author !== "assistant" ? `${esc(view.reply.author)} · ` : ""}${age(view.reply.updatedAt)}</small></p>`
      : view.kind === "queued" ? `<p class="focus-wait">queued · sent when the assistant is free</p>`
      : view.kind === "waiting" ? `<p class="focus-wait">waiting for the assistant…</p>`
      : view.kind === "terminal" ? `<p class="focus-wait">answered in its terminal · ${look}</p>`
      // Dropped, failed or sent to an incarnation that is gone: never "waiting"; the terminal is where to look.
      : view.kind === "unconfirmed" ? `<p class="focus-wait">not confirmed · the assistant restarted · ${look}</p>`
      : view.kind === "failed" ? `<p class="focus-wait focus-reply-error">not sent${view.error ? ` · ${esc(view.error)}` : ""} · ${look}</p>` : "";
    return `<div class="focus-reply">${you}${line}</div>`;
  }
  // Cards: every next row and today intention expands to its details; open state survives re-renders.
  // The summary holds only text: the action, checkbox and chips are its siblings in the row (axe nested-interactive).
  const openCards = new Set<string>();
  // The user's open cards, newest last; bounded so keys of sessions that never come back do not pile up.
  const OPEN_CARDS_MAX = 64;
  const openCard = (key: string) => { openCards.delete(key); openCards.add(key); if (openCards.size > OPEN_CARDS_MAX) openCards.delete(openCards.values().next().value!); };
  // Session cards emitted by the last render (either host): only these fetch their context.
  const renderedSessions = new Map<string, FocusSession>();
  const stamp = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const field = (label: string, value: string) => value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : "";
  const project = (path?: string) => path ? `<span title="${escAttr(path)}">${esc(path.replace(/\/+$/, "").split("/").pop() || path)}</span>` : "";
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
    return field("machine", esc(session.machine ?? "")) + field("project", project(session.cwd))
      + field("state", `${esc(session.state === "needs-input" ? "needs you" : session.state)}${session.changedAt ? ` · since ${age(session.changedAt)}` : ""}`)
      + field("last line", session.lastLine ? `<code>${esc(session.lastLine)}</code>` : "") + field("why here", esc(row.reason)) + field("for", esc(row.intention?.title ?? ""));
  }
  function intentionBody(intention: FocusIntention, reason?: string) {
    const linked = linkedFocusSessions(intention, deps.sessions());
    return field("sessions", linked.map(s => `<span class="focus-linked">${dot(s.state)}${esc(s.name)}</span>`).join(" ") || "none yet")
      + field("project", project(intention.project)) + field("machine", esc(intention.machine ?? "")) + field("added", stamp(intention.createdAt))
      + field("done", intention.done && intention.doneAt ? stamp(intention.doneAt) : "") + field("why here", esc(reason ?? ""));
  }
  function nextHtml(cap: number) {
    const rows = rankFocus(doc(), deps.sessions(), cap);
    if (!rows.length) return `<p class="focus-empty">${doc().intentions.length && doc().intentions.every(i => i.done) ? "all intentions done — tell the assistant what's next" : "nothing waiting"}</p>`;
    return `<ol class="focus-next" aria-label="Next actions">${rows.map((row, index) => {
      const finished = row.session?.state === "done";
      const title = row.session ? `${row.session.name} ${row.session.state === "needs-input" ? "needs you" : finished ? "finished" : row.session.state}` : `start “${row.intention!.title}”`;
      // A start row and the same intention's today card are separate cards: `start:` here, `intention:` in today.
      const key = row.session ? `session:${row.session.id}` : `start:${row.intention!.id}`;
      if (row.session) renderedSessions.set(key, row.session);
      const action = `<button type="button" class="focus-action" data-focus-next="${index}" data-focus-key="${escAttr(`act:${key}`)}" aria-label="${escAttr(row.session ? `${row.kind} ${title}` : title)}">${row.kind}<span aria-hidden="true"> ›</span></button>`;
      const summary = `<span class="focus-rank">${index + 1}</span>${dot(row.session?.state ?? "idle")}<span class="focus-title">${esc(title)}${row.session?.changedAt ? `<small> · ${finished ? clock(row.session.changedAt) : age(row.session.changedAt)}</small>` : ""}</span><small class="focus-for">${esc(row.intention?.title ?? row.session?.machine ?? "")}</small>`;
      return `<li${index >= 3 ? ' class="focus-extra"' : ""}>${card(key, summary, row.session ? sessionBody(row, row.session) : intentionBody(row.intention!, row.reason), row.session ? contextHtml(row.session) : "")}${action}</li>`;
    }).join("")}</ol>`;
  }
  function todayHtml(items: FocusIntention[]) {
    return `<ul class="focus-today" aria-label="Intentions">${items.map(i => `<li${i.done ? ' class="done"' : ""}><label class="focus-check"><input type="checkbox" data-focus-done="${escAttr(i.id)}" data-focus-key="${escAttr(i.id)}" aria-label="Done: ${escAttr(i.title)}"${i.done ? " checked" : ""}${locked() ? " disabled" : ""}></label>${card(`intention:${i.id}`, `<span class="focus-title">${esc(i.title)}</span>`, intentionBody(i))}<span class="focus-chips">${linkedFocusSessions(i, deps.sessions()).map(s => `<button type="button" data-focus-session="${escAttr(s.id)}">${dot(s.state)}${esc(s.name)}</button>`).join("")}</span></li>`).join("")}</ul>`;
  }
  function render() {
    renderedSessions.clear();
    const current = doc();
    const enabled = !!focus?.assistant?.enabled;
    const state = status();
    const next = rankFocus(current, deps.sessions(), 5);
    const summary = `${current.intentions.filter(i => i.done).length} of ${current.intentions.length} done`;
    // "know when items are done": today's ticks and finishes carry a time; the rest of the list stays as it was.
    const done = doneToday(current, deps.sessions(), Date.now(), doneDay);
    const latest = done[0] && ` · ${done[0].kind === "intention" ? `✓ ${esc(done[0].intention.title)}` : `${esc(done[0].session.name)} finished`} ${clock(done[0].at)}`;
    const doneHtml = done.length ? `<h2>done today <small>${plural(done.filter(i => i.kind === "intention").length, "intention")} · ${plural(done.filter(i => i.kind === "session").length, "session")}</small></h2><ul class="focus-done" aria-label="Done today">${done.map(i => `<li><span class="focus-time">${clock(i.at)}</span>${i.kind === "intention"
      ? `<span class="focus-what">✓ ${esc(i.intention.title)}</span><button type="button" data-focus-undo="${escAttr(i.intention.id)}" aria-label="Undo done: ${escAttr(i.intention.title)}"${locked() ? " disabled" : ""}>undo</button>`
      : `<span class="focus-what"><b>${esc(i.session.name)}</b> finished · for ${esc(i.intention.title)}</span><button type="button" data-focus-session="${escAttr(i.session.id)}">open ›</button>`}</li>`).join("")}</ul>` : "";
    const open = current.intentions.filter(i => !(i.done && i.doneAt && doneDay(i.doneAt) === localDay(Date.now())));
    const r = routines();
    const catching = r?.catchingUp;
    // Every state names the user's move: answer, catch up now, look at its terminal; never only what the system is doing.
    const info = offline ? `focus from ${current.updatedAt ? when(current.updatedAt) : "cache"} · ${homeName} offline · read-only`
      : state === "needs you" ? "needs you · answer"
      : r?.surfaced ? `has not confirmed reading activity · sent ${r.surfaced.sends} times`
      : catching?.unconfirmed ? `reading activity · ${DELIVERY_UNCONFIRMED}`
      : catching ? `reading activity${catching.since ? ` since ${when(catching.since)}` : ""} · ${plural(catching.machines, "machine")}`
      : r?.stale ? `quiet since ${when(r.stale.since)}` : `${state} · ${freshness()}`;
    const nudgeDay = current.nudge && localDay(Date.parse(current.nudge.updatedAt));
    const nudge = current.nudge?.text ? `<p class="focus-nudge${catching ? " from" : ""}">${esc(current.nudge.text)}${catching && nudgeDay !== localDay(Date.now()) ? ` <small>from ${dayName(nudgeDay!)}</small>` : ""}</p>` : "";
    const catchUp = button("catch-up", "catch up now");
    const noteItems = [...(r ? [...r.unreachable.map(m => esc(`${m.name} not reached ${m.since ? `since ${when(m.since)}` : "yet"} · its day is reviewed when it is back`)), ...(r.surfaced ? [`${r.stale ? `quiet since ${when(r.stale.since)} · ` : ""}look at its terminal, then ${catchUp}`] : []), ...(r.stale && !r.surfaced ? [catchUp] : []), ...[r.notice, r.error].filter(Boolean).map(t => esc(t!))] : []), ...(!offline && enabled && focus?.assistant?.error ? [esc(focus.assistant.error)] : [])].map(n => `<span>${n}</span>`).join("");
    const notes = noteItems ? `<p class="focus-notes">${noteItems}</p>` : "";
    const summaryDay = current.daySummary;
    // A day note stays listed until it is marked read after that activity day ended (its turn at the
    // fallback time, from the home server; calendar midnight when routines are unavailable). seenDayNoteAt is shared across devices.
    const noteDay = r?.yesterday?.date === summaryDay?.date ? r?.yesterday : undefined;
    const dayEnd = summaryDay && (noteDay ? Date.parse(noteDay.endsAt) : new Date(`${summaryDay.date}T00:00`).getTime() + 864e5);
    const yesterday = summaryDay && !(current.seenDayNoteAt && Date.parse(current.seenDayNoteAt) >= dayEnd!)
      ? `<div class="focus-yesterday"><h2>${dayName(summaryDay.date)}</h2><span>${summaryDay.done} done · ${summaryDay.carried} carried over · ${summaryDay.questions} question${summaryDay.questions === 1 ? "" : "s"}</span>${button("day-note", "read ›", `Read day note for ${summaryDay.date}`, noteDay?.note === false)}</div>` : "";
    // The dot follows the user's move: amber while a routine waits on its terminal, red while the home is unreachable.
    const tone = dot(offline ? "failed" : r?.surfaced ? "needs you" : state);
    // Nothing of the focus ui shows while the assistant is off: tile, block and page stay hidden; settings is the only door.
    // Disabled from another device while the page is open: leave it once, on the transition (show re-enters render).
    const closing = wasEnabled && !enabled;
    wasEnabled = enabled;
    if (closing && document.getElementById("assistant-view")?.classList.contains("visible")) deps.show("sessions");
    const tile = document.getElementById("sidebar-assistant");
    const tileStatus = !focus?.document ? "set focus" : offline ? "offline" : state === "needs you" ? state : state === "failed" ? "failed" : r?.surfaced ? "needs you" : catching ? "reading" : r?.stale ? `quiet ${age(r.stale.since)}` : `${next.length} next`;
    if (tile) { tile.hidden = !enabled; tile.innerHTML = `<span>${tone}assistant</span> <small>${tileStatus}</small>`; tile.title = current.nudge?.text ?? info; tile.setAttribute("aria-label", `Assistant ${tileStatus}. ${state}. Open assistant`); }
    const block = document.getElementById("dashboard-focus");
    if (block) block.hidden = !enabled;
    const attn = state === "needs you" ? `<button type="button" class="focus-attn" data-focus-action="talk">${dot(state)} ${esc(info)} ›</button>` : "";
    replace("dashboard-focus", !enabled ? "" : `<div class="focus-header">${attn || `${tone}${button("view", "assistant", "Open assistant")}<small${catching ? ' class="focus-spin"' : ""}>${esc(info)}</small>`}${button("view", "open assistant ›", "Open assistant page")}</div>${notes}${nudge}${focus?.document ? nextHtml(3) + `<small>today · ${summary}${latest ?? ""}</small>` : `<p>Set your focus</p>${addForm(true)}`}${error ? `<p role="status">${esc(error)}</p>` : ""}`);
    replace("assistant-content", !enabled ? "" : `<div class="focus-header">${attn || `<span${catching ? ' class="focus-spin"' : ""}>${tone} ${esc(info)}</span>`}${button("settings", "settings", "Assistant settings")}</div>${notes}<div class="focus-conversation"><form data-focus-form="ask"><input type="text" data-focus-key="ask" aria-label="Ask the assistant" placeholder="ask…" maxlength="8000" required${locked() ? " disabled" : ""}><button type="submit"${locked() ? " disabled" : ""}>Ask</button></form><button type="button" data-focus-action="talk" aria-label="Talk to assistant"${offline || !focus?.assistant?.session ? " disabled" : ""}>talk</button></div>${replyHtml()}${nudge}<h2>next</h2>${nextHtml(5)}<details><summary>why this order</summary><ol>${next.map(r => `<li>${esc(r.reason)}</li>`).join("")}</ol></details><h2>today <small>${summary}</small></h2>${todayHtml(open)}${addForm(!focus?.document)}<small>reorder, reword or drop: tell the assistant</small>${doneHtml}${yesterday}`);
    const live = document.getElementById("focus-status");
    if (live) live.textContent = error || focus?.assistant?.error || (focus?.assistant?.queued ? `${focus.assistant.queued} queued` : notice);
    const setting = document.getElementById("assistant-setting-status");
    if (setting) setting.textContent = enabled ? `on · ${info}` : "off";
    const settingError = document.getElementById("assistant-setting-error");
    if (settingError) settingError.textContent = error || focus?.assistant?.error || "";
    const settingHome = document.getElementById("assistant-setting-home");
    if (settingHome) settingHome.textContent = `Home: ${homeName}${focus?.assistant?.folder ? ` · ${focus.assistant.folder}` : ""}. Needs pi installed and logged in there (pi, then /login).`;
    const toggle = document.getElementById("assistant-setting-toggle") as HTMLButtonElement;
    if (toggle) { toggle.textContent = enabled ? "Disable assistant…" : "Enable assistant…"; toggle.disabled = locked(); }
    const settingOpen = document.getElementById("assistant-setting-open");
    if (settingOpen) settingOpen.hidden = !enabled;
    const terminalState = document.getElementById("assistant-terminal-state");
    if (terminalState) terminalState.textContent = focus?.assistant?.queued ? `${focus.assistant.queued} queued` : focus?.assistant?.error ?? state;
  }
  async function refresh(open = !opened) {
    if (flight) return flight;
    opened = true;
    flight = (async () => {
      const epoch = writes;
      try {
        let response = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, undefined, false);
        const home = response.local ? { key: "", name: "this machine" } : deps.homeMachine(response.home);
        if (focus && focus.home !== response.home) focus = { ...response, document: null };
        machine = home?.key ?? "";
        homeName = home?.name ?? "sgt";
        if (!response.local) {
          if (!home) { if (focus?.home !== response.home) focus = { ...response, document: null }; throw new Error(`${homeName} offline`); }
          const remote = await deps.request<FocusResponse>(open ? "/focus?open=1" : "/focus", undefined, machine, false);
          if (!remote.local || remote.installationId !== response.home) throw new Error("focus home identity changed");
          response = remote;
        }
        if (response.document !== null && !isFocusDocument(response.document)) throw new Error("invalid focus document");
        // A write saved while this poll was in flight is newer than the document it carries: keep the written one.
        focus = writes !== epoch && focus?.home === response.home ? { ...response, document: focus.document, revision: focus.revision } : response;
        offline = false; error = "";
        pendingAsk = observePendingAsk(pendingAsk, activity(), Date.now());
        for (const session of openSessions()) void loadContext(session);
        cache(focus);
      } catch (e) { offline = true; error = e instanceof Error ? e.message : "focus unavailable"; }
      answered = true;
      render();
    })().finally(() => { flight = undefined; });
    return flight;
  }
  async function write(op: FocusOp | (() => FocusOp)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (offline) throw new Error("focus home is offline; changes were not saved");
      if (!answered) throw new Error("focus is still loading; changes were not saved");
      try {
        const saved = await deps.request<FocusResponse>("/focus", { method: "POST", body: JSON.stringify({ expectedRevision: doc().revision, ops: [typeof op === "function" ? op() : op] }) }, machine);
        focus = { ...saved, assistant: focus?.assistant };
        writes++;
        cache(focus);
        notice = "focus updated";
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
  function talk() { if (focus?.assistant?.session && !offline) deps.open(focus.assistant.session, machine); }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try { await action(); error = ""; } catch (e) { error = e instanceof Error ? e.message : "focus action failed"; }
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
      if (action === "talk") talk();
      if (action === "catch-up") void run(async () => { const next = await deps.request<RoutineStatus>("/focus/catch-up", { method: "POST" }, machine); if (focus) focus.routines = next; });
      if (action === "day-note") void run(readDayNote);
      if (target.dataset.focusUndo) void run(() => write({ type: "undo", id: target.dataset.focusUndo! }));
      if (target.dataset.focusNext !== undefined) {
        const row = rankFocus(doc(), deps.sessions(), id === "dashboard-focus" ? 3 : 5)[Number(target.dataset.focusNext)];
        if (row?.session) deps.open(row.session.name, row.session.machineUrl); else if (row?.intention) deps.start(row.intention);
      }
      const session = deps.sessions().find(s => s.id === target.dataset.focusSession);
      if (session) deps.open(session.name, session.machineUrl);
    });
    // toggle does not bubble: listen in the capture phase.
    host.addEventListener("toggle", event => {
      const key = (event.target as HTMLElement).dataset?.focusCard;
      if (!key) return;
      if (!(event.target as HTMLDetailsElement).open) { openCards.delete(key); return; }
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
        if (form.dataset.focusForm === "ask") {
          const priorReplyAt = doc().reply?.updatedAt ?? null;
          const { delivery, ...assistant } = await deps.request<AssistantStatus & { delivery: PendingAsk["delivery"] }>("/focus/ask", { method: "POST", body: JSON.stringify({ text }) }, machine);
          if (focus) focus.assistant = assistant;
          pendingAsk = startPendingAsk(text, delivery, priorReplyAt, activity(assistant), Date.now());
        }
        else await write({ type: "add", intention: { id: crypto.randomUUID(), title: text } });
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
  render();
  return { refresh, render, loadTiming,
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
