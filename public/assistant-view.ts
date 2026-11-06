import { esc, escAttr } from "./app-state";
import { rankFocus, linkedFocusSessions, type FocusSession } from "../src/focus-ranking";
import { emptyFocus, isFocusDocument, type FocusDocument, type FocusIntention, type FocusOp } from "../src/focus-contract";
interface AssistantStatus { enabled: boolean; folder: string; state: string; session?: string; sessionId?: string; queued: number; error?: string }
interface FocusResponse { home: string; installationId: string; local: boolean; document: FocusDocument | null; revision: number; assistant?: AssistantStatus }
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
  const cacheKey = "wolfpack-focus-cache";
  try { const cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && (cached.document === null || isFocusDocument(cached.document))) { focus = cached; offline = true; } } catch { /* no valid cached focus */ }
  const doc = () => focus?.document ?? emptyFocus();
  const status = () => offline ? `${homeName} offline` : focus?.assistant?.error ? "failed" : focus?.assistant?.enabled ? (focus.assistant.state === "needs-input" ? "needs you" : focus.assistant.state) : "off";
  const freshness = () => doc().updatedAt ? `updated ${age(doc().updatedAt!)}` : "set your focus";
  function age(at: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
    return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
  }
  const button = (action: string, label: string, name = label) => `<button type="button" data-focus-action="${action}" aria-label="${escAttr(name)}">${esc(label.replace(" ›", ""))}${label.endsWith(" ›") ? '<span aria-hidden="true"> ›</span>' : ""}</button>`;
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
      const title = row.session ? `${row.session.name} ${row.session.state === "needs-input" ? "needs you" : row.session.state}` : `start “${row.intention!.title}”`;
      return `<li${index >= 3 ? ' class="focus-extra"' : ""}><button type="button" data-focus-next="${index}"><span class="focus-rank">${index + 1}</span>${dot(row.session?.state ?? "idle")}<span class="focus-title">${esc(title)}${row.session?.changedAt ? `<small> · ${age(row.session.changedAt)}</small>` : ""}</span><small class="focus-for">${esc(row.intention?.title ?? row.session?.machine ?? "")}</small><span class="focus-action">${row.kind} ›</span></button></li>`;
    }).join("")}</ol>`;
  }
  function render() {
    const current = doc();
    const state = status();
    const next = rankFocus(current, deps.sessions(), 5);
    const summary = `${current.intentions.filter(i => i.done).length} of ${current.intentions.length} done`;
    const info = offline ? `focus from ${current.updatedAt ? new Date(current.updatedAt).toLocaleString() : "cache"} · ${homeName} offline` : `${state} · ${freshness()}`;
    const nudge = current.nudge?.text ? `<p class="focus-nudge">${esc(current.nudge.text)}</p>` : "";
    const tile = document.getElementById("sidebar-assistant");
    const tileStatus = !focus?.document ? "set up" : offline ? "offline" : state === "needs you" ? state : state === "off" ? "off" : state === "failed" ? "failed" : `${next.length} next`;
    if (tile) { tile.innerHTML = `<span>${dot(state)}assistant</span> <small>${tileStatus}</small>`; tile.title = current.nudge?.text ?? info; tile.setAttribute("aria-label", `Assistant ${tileStatus}. ${state}. Open assistant`); }
    replace("dashboard-focus", `<div class="focus-header">${dot(state)}${button("view", "assistant", "Open assistant")}<small>${esc(info)}</small>${button("view", "open assistant ›", "Open assistant page")}</div>${nudge}${focus?.document ? nextHtml(3) + `<small>today · ${summary}</small>` : `<p>Set your focus</p>${addForm(true)}`}${error || focus?.assistant?.error ? `<p role="status">${esc(error || focus?.assistant?.error || "")}</p>` : ""}`);
    const enabled = !!focus?.assistant?.enabled;
    replace("assistant-content", `<div class="focus-header"><span>${dot(state)} ${esc(info)}</span>${button("settings", enabled ? "settings" : "enable assistant", enabled ? "Assistant settings" : "Enable assistant — settings")}</div>${enabled ? `<div class="focus-conversation"><form data-focus-form="ask"><input type="text" data-focus-key="ask" aria-label="Ask the assistant" placeholder="ask…" maxlength="8192" required${offline || busy ? " disabled" : ""}><button type="submit"${offline || busy ? " disabled" : ""}>Ask</button></form><button type="button" data-focus-action="talk" aria-label="Talk to assistant"${offline || !focus?.assistant?.session ? " disabled" : ""}>talk</button></div>` : ""}${nudge}<h2>next</h2>${nextHtml(5)}<details><summary>why this order</summary><ol>${next.map(r => `<li>${esc(r.reason)}</li>`).join("")}</ol></details><h2>today <small>${summary}</small></h2><ul class="focus-today" aria-label="Intentions">${current.intentions.map(i => `<li${i.done ? ' class="done"' : ""}><label><input type="checkbox" data-focus-done="${escAttr(i.id)}" data-focus-key="${escAttr(i.id)}" aria-label="Done: ${escAttr(i.title)}"${i.done ? " checked" : ""}${offline || busy ? " disabled" : ""}><span>${esc(i.title)}</span></label><span class="focus-chips">${linkedFocusSessions(i, deps.sessions()).map(s => `<button type="button" data-focus-session="${escAttr(s.id)}">${dot(s.state)}${esc(s.name)}</button>`).join("")}</span></li>`).join("")}</ul>${addForm(!focus?.document)}<small>reorder, reword or drop: tell the assistant</small>`);
    const live = document.getElementById("focus-status");
    if (live) live.textContent = error || focus?.assistant?.error || (focus?.assistant?.queued ? `${focus.assistant.queued} queued` : notice);
    const setting = document.getElementById("assistant-setting-status");
    if (setting) setting.textContent = `${enabled ? "enabled" : "off"} · home: ${homeName}${focus?.assistant?.folder ? ` · ${focus.assistant.folder}` : ""}${error ? ` · ${error}` : ""}`;
    const toggle = document.getElementById("assistant-setting-toggle") as HTMLButtonElement;
    if (toggle) { toggle.textContent = enabled ? "Disable assistant" : "Enable assistant"; toggle.disabled = offline || busy; }
    const terminalState = document.getElementById("assistant-terminal-state");
    if (terminalState) terminalState.textContent = focus?.assistant?.queued ? `${focus.assistant.queued} queued` : focus?.assistant?.error ?? state;
  }
  async function refresh() {
    if (flight) return flight;
    flight = (async () => {
      try {
        let response = await deps.request<FocusResponse>("/focus", undefined, undefined, false);
        const home = response.local ? { key: "", name: "this machine" } : deps.homeMachine(response.home);
        if (focus && focus.home !== response.home) focus = { ...response, document: null };
        machine = home?.key ?? "";
        homeName = home?.name ?? "sgt";
        if (!response.local) {
          if (!home) { if (focus?.home !== response.home) focus = { ...response, document: null }; throw new Error(`${homeName} offline`); }
          const remote = await deps.request<FocusResponse>("/focus", undefined, machine, false);
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
  async function write(op: FocusOp) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (offline) throw new Error("focus home is offline; changes were not saved");
      try {
        const saved = await deps.request<FocusResponse>("/focus", { method: "POST", body: JSON.stringify({ expectedRevision: doc().revision, ops: [op] }) }, machine);
        focus = { ...saved, assistant: focus?.assistant };
        try { localStorage.setItem(cacheKey, JSON.stringify(focus)); } catch { /* optional cache */ }
        notice = "focus updated";
        return;
      } catch (e) { if (attempt || (e as { status?: number }).status !== 409) throw e; await refresh(); }
    }
  }
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
  }); };
  render();
  return { refresh, render, isAssistant: (name: string, key: string) => name === focus?.assistant?.session && key === machine };
}
