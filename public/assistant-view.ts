import { linkStartedFocusSession, type FocusSessionStart, type StartedFocusSession } from "../src/focus-start";
import { esc, escAttr } from "./app-state";
import { rankFocus, linkedFocusSessions, doneToday, type FocusSession } from "../src/focus-ranking";
import { emptyFocus, isFocusDocument, type FocusDocument, type FocusIntention, type FocusOp } from "../src/focus-contract";
import type { AssistantTiming } from "../src/focus-scheduler";
import { showAppDialog } from "./app-dialog";
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
  let error = "";
  let notice = "";
  let flight: Promise<void> | undefined;
  let busy = false;
  let opened = false;
  let wasEnabled = false;
  const cacheKey = "wolfpack-focus-cache";
  try { const cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && (cached.document === null || isFocusDocument(cached.document))) { focus = cached; offline = true; } } catch { /* no valid cached focus */ }
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
    return `<form data-focus-form="add" class="focus-add"><input type="text" data-focus-key="add" aria-label="${label}" placeholder="${first ? "what are you working on?" : "add an intention…"}" maxlength="500" required${offline || busy ? " disabled" : ""}><button type="submit"${offline || busy ? " disabled" : ""}>Add</button></form>`;
  }
  function nextHtml(cap: number) {
    const rows = rankFocus(doc(), deps.sessions(), cap);
    if (!rows.length) return `<p class="focus-empty">${doc().intentions.length && doc().intentions.every(i => i.done) ? "all intentions done — tell the assistant what's next" : "nothing waiting"}</p>`;
    return `<ol class="focus-next" aria-label="Next actions">${rows.map((row, index) => {
      const finished = row.session?.state === "done";
      const title = row.session ? `${row.session.name} ${row.session.state === "needs-input" ? "needs you" : finished ? "finished" : row.session.state}` : `start “${row.intention!.title}”`;
      return `<li${index >= 3 ? ' class="focus-extra"' : ""}><button type="button" data-focus-next="${index}"><span class="focus-rank">${index + 1}</span>${dot(row.session?.state ?? "idle")}<span class="focus-title">${esc(title)}${row.session?.changedAt ? `<small> · ${finished ? clock(row.session.changedAt) : age(row.session.changedAt)}</small>` : ""}</span><small class="focus-for">${esc(row.intention?.title ?? row.session?.machine ?? "")}</small><span class="focus-action">${row.kind} ›</span></button></li>`;
    }).join("")}</ol>`;
  }
  function render() {
    const current = doc();
    const enabled = !!focus?.assistant?.enabled;
    const state = status();
    const next = rankFocus(current, deps.sessions(), 5);
    const summary = `${current.intentions.filter(i => i.done).length} of ${current.intentions.length} done`;
    // "know when items are done": today's ticks and finishes carry a time; the rest of the list stays as it was.
    const done = doneToday(current, deps.sessions(), Date.now(), doneDay);
    const latest = done[0] && ` · ${done[0].kind === "intention" ? `✓ ${esc(done[0].intention.title)}` : `${esc(done[0].session.name)} finished`} ${clock(done[0].at)}`;
    const doneHtml = done.length ? `<h2>done today <small>${plural(done.filter(i => i.kind === "intention").length, "intention")} · ${plural(done.filter(i => i.kind === "session").length, "session")}</small></h2><ul class="focus-done" aria-label="Done today">${done.map(i => `<li><span class="focus-time">${clock(i.at)}</span>${i.kind === "intention"
      ? `<span class="focus-what">✓ ${esc(i.intention.title)}</span><button type="button" data-focus-undo="${escAttr(i.intention.id)}" aria-label="Undo done: ${escAttr(i.intention.title)}"${offline || busy ? " disabled" : ""}>undo</button>`
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
    replace("assistant-content", !enabled ? "" : `<div class="focus-header">${attn || `<span${catching ? ' class="focus-spin"' : ""}>${tone} ${esc(info)}</span>`}${button("settings", "settings", "Assistant settings")}</div>${notes}<div class="focus-conversation"><form data-focus-form="ask"><input type="text" data-focus-key="ask" aria-label="Ask the assistant" placeholder="ask…" maxlength="8192" required${offline || busy ? " disabled" : ""}><button type="submit"${offline || busy ? " disabled" : ""}>Ask</button></form><button type="button" data-focus-action="talk" aria-label="Talk to assistant"${offline || !focus?.assistant?.session ? " disabled" : ""}>talk</button></div>${nudge}<h2>next</h2>${nextHtml(5)}<details><summary>why this order</summary><ol>${next.map(r => `<li>${esc(r.reason)}</li>`).join("")}</ol></details><h2>today <small>${summary}</small></h2><ul class="focus-today" aria-label="Intentions">${open.map(i => `<li${i.done ? ' class="done"' : ""}><label><input type="checkbox" data-focus-done="${escAttr(i.id)}" data-focus-key="${escAttr(i.id)}" aria-label="Done: ${escAttr(i.title)}"${i.done ? " checked" : ""}${offline || busy ? " disabled" : ""}><span>${esc(i.title)}</span></label><span class="focus-chips">${linkedFocusSessions(i, deps.sessions()).map(s => `<button type="button" data-focus-session="${escAttr(s.id)}">${dot(s.state)}${esc(s.name)}</button>`).join("")}</span></li>`).join("")}</ul>${addForm(!focus?.document)}<small>reorder, reword or drop: tell the assistant</small>${doneHtml}${yesterday}`);
    const live = document.getElementById("focus-status");
    if (live) live.textContent = error || focus?.assistant?.error || (focus?.assistant?.queued ? `${focus.assistant.queued} queued` : notice);
    const setting = document.getElementById("assistant-setting-status");
    if (setting) setting.textContent = enabled ? `on · ${info}` : "off";
    const settingError = document.getElementById("assistant-setting-error");
    if (settingError) settingError.textContent = error || focus?.assistant?.error || "";
    const settingHome = document.getElementById("assistant-setting-home");
    if (settingHome) settingHome.textContent = `Home: ${homeName}${focus?.assistant?.folder ? ` · ${focus.assistant.folder}` : ""}. Needs pi installed and logged in there (pi, then /login).`;
    const toggle = document.getElementById("assistant-setting-toggle") as HTMLButtonElement;
    if (toggle) { toggle.textContent = enabled ? "Disable assistant…" : "Enable assistant…"; toggle.disabled = offline || busy; }
    const settingOpen = document.getElementById("assistant-setting-open");
    if (settingOpen) settingOpen.hidden = !enabled;
    const terminalState = document.getElementById("assistant-terminal-state");
    if (terminalState) terminalState.textContent = focus?.assistant?.queued ? `${focus.assistant.queued} queued` : focus?.assistant?.error ?? state;
  }
  async function refresh(open = !opened) {
    if (flight) return flight;
    opened = true;
    flight = (async () => {
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
        focus = response; offline = false; error = "";
        try { localStorage.setItem(cacheKey, JSON.stringify(response)); } catch { /* storage unavailable; live view still works */ }
      } catch (e) { offline = true; error = e instanceof Error ? e.message : "focus unavailable"; }
      render();
    })().finally(() => { flight = undefined; });
    return flight;
  }
  async function write(op: FocusOp | (() => FocusOp)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (offline) throw new Error("focus home is offline; changes were not saved");
      try {
        const saved = await deps.request<FocusResponse>("/focus", { method: "POST", body: JSON.stringify({ expectedRevision: doc().revision, ops: [typeof op === "function" ? op() : op] }) }, machine);
        focus = { ...saved, assistant: focus?.assistant };
        try { localStorage.setItem(cacheKey, JSON.stringify(focus)); } catch { /* optional cache */ }
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
        if (form.dataset.focusForm === "ask") { const assistant = await deps.request<AssistantStatus>("/focus/ask", { method: "POST", body: JSON.stringify({ text }) }, machine); if (focus) focus.assistant = assistant; talk(); }
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
