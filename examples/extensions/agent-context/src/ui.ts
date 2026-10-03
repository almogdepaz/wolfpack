import type { ContextViewContribution, ExtensionRegistrationHost } from "wolfpack-bridge/extensions";
import { acceptsRevision, contextViewModel, type ContextBullet, type PlanStatus } from "./model.ts";
import { styles } from "./styles.ts";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
}
function setText(element: HTMLElement, value: string): void { if (element.textContent !== value) element.textContent = value; }
function chevron(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "wac-chevron"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", "m6 3 5 5-5 5"); svg.append(path); return svg;
}
const statuses: Record<PlanStatus, { label: string; marker: string }> = {
  pending: { label: "Pending", marker: "○" }, in_progress: { label: "In progress", marker: "→" },
  complete: { label: "Complete", marker: "✓" }, blocked: { label: "Blocked", marker: "!" },
};

const view: ContextViewContribution = {
  id: "context",
  title: "Agent Context",
  mount(container, context) {
    const root = node("section", "wolfpack-agent-context");
    const events = new AbortController();
    let latest = -1; let stopped = false; let unsubscribe = () => {};
    const saved = (key: string): string | null => { try { return context.storage.get(key); } catch { return null; } };
    const save = (key: string, value: string): boolean => { try { context.storage.set(key, value); return true; } catch { return false; } };
    const meta = node("div", "wac-meta"); const revisionLabel = node("span", "wac-revision");
    meta.append(node("span", "", "Agent-authored"), revisionLabel);
    const goalCard = node("div", "wac-goal"); const goal = node("h2");
    goalCard.append(node("span", "wac-eyebrow", "Current goal"), goal);
    const feedback = node("p", "wac-feedback"); feedback.setAttribute("role", "status");
    function copyButton(label: string, value: string): HTMLButtonElement {
      const button = node("button", "wac-button", label); button.type = "button";
      button.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(value); if (!stopped) setText(feedback, "Copied to clipboard."); }
        catch { if (!stopped) setText(feedback, "Could not copy. Select the text and copy it manually."); }
      }, { signal: events.signal });
      return button;
    }
    const guidance = node("div", "wac-guidance");
    const request = "Update this session's context using the wolfpack-agent-context skill.";
    guidance.append(node("p", "", "Ask your agent to publish a brief for this session. It will resolve the session automatically."), node("p", "wac-request", request), copyButton("Copy request", request), node("p", "", "Context is not extracted automatically from terminal output."));
    const unavailable = node("p", "wac-feedback", "The document could not be read or did not match the context format. Ask the agent to check its published document. Your local draft is unaffected.");
    const content = node("div", "wac-content");
    const clear = node("p", "wac-clear", "✓  No blockers reported");

    function section(title: string, className = "") {
      const element = node("section", `wac-section ${className}`); element.setAttribute("aria-label", title);
      const heading = node("div", "wac-section-head"); const count = node("span", "wac-count");
      const list = node("ul", "wac-list"); list.setAttribute("role", "list");
      heading.append(node("h3", "", title), count); element.append(heading, list);
      return { element, heading, count, list };
    }
    const plan = section("Plan"); const next = section("Next steps"); const decisions = section("Decisions"); const blockers = section("Blockers", "wac-blockers");
    const progress = node("progress", "wac-progress"); progress.setAttribute("aria-label", "Agent-reported plan completion");
    plan.heading.after(progress);
    content.append(plan.element, next.element, decisions.element);

    function tool(title: string, key: string, defaultOpen = false) {
      const element = node("details", "wac-tool"); const summary = node("summary"); summary.append(node("span", "", title), chevron());
      const body = node("div", "wac-tool-body"); element.append(summary, body);
      element.open = saved(key) === "true" || (saved(key) === null && defaultOpen);
      element.addEventListener("toggle", () => save(key, String(element.open)), { signal: events.signal });
      return { element, body };
    }
    const draft = node("textarea"); draft.placeholder = "Ideas to keep for later…"; draft.setAttribute("aria-label", "Local draft"); draft.value = saved("draft") ?? "";
    const draftTool = tool("Local draft", "draft-open", draft.value.length > 0);
    const draftNote = node("p", "", "Saved in this browser only. Not published to the agent.");
    draft.addEventListener("input", () => setText(draftNote, save("draft", draft.value) ? "Saved in this browser only. Not published to the agent." : "Could not save in this browser. Copy your draft before leaving."), { signal: events.signal });
    draftTool.body.append(draft, draftNote);
    const sessionTool = tool("Session details", "session-open");
    sessionTool.body.append(node("code", "wac-session-id", context.scope.sessionId), copyButton("Copy session ID", context.scope.sessionId), node("p", "", "Agent-authored context — not verified task or execution evidence."));
    const tools = node("div", "wac-tools"); tools.append(draftTool.element, sessionTool.element);
    root.append(node("style", "", styles), meta, goalCard, guidance, unavailable, blockers.element, clear, content, tools, feedback);
    container.replaceChildren(root);

    type Row = { li: HTMLLIElement; disclosure: HTMLDetailsElement; summary: HTMLElement; plain: HTMLElement; caption: HTMLElement; title: HTMLElement; status: HTMLElement; marker: HTMLElement; body: HTMLElement; arrow: SVGSVGElement };
    const rows = new Map<string, Row>();
    function makeRow(key: string, initiallyOpen: boolean): Row {
      const li = node("li", "wac-item"); li.dataset.bullet = key;
      const disclosure = node("details"); const summary = node("summary"); const plain = node("div", "wac-static");
      const caption = node("span", "wac-caption"); const title = node("span", "wac-title"); const status = node("span", "wac-status");
      const marker = node("span", "wac-marker"); marker.setAttribute("aria-hidden", "true");
      const words = node("span", "wac-caption-text"); const arrow = chevron(); words.append(title, status); caption.append(marker, words, arrow);
      const body = node("p", "wac-detail"); summary.append(caption); disclosure.append(summary, body); li.append(disclosure, plain);
      const preference = saved(`bullet-open:${key}`); disclosure.open = preference === "true" || (preference === null && initiallyOpen);
      // Delegate toggle ownership to the retained list row; removing a row releases its listener with the DOM.
      disclosure.ontoggle = () => { if (!stopped) save(`bullet-open:${key}`, String(disclosure.open)); };
      return { li, disclosure, summary, plain, caption, title, status, marker, body, arrow };
    }
    function renderList(group: ReturnType<typeof section>, name: string, values: readonly (string | ContextBullet)[], planStatuses?: readonly PlanStatus[]) {
      const wanted = new Set<string>(); const occurrences = new Map<string, number>(); let cursor = group.list.firstElementChild;
      values.forEach((value, index) => {
        const bullet = typeof value === "string" ? { id: `legacy-${index}`, text: value } : value;
        const occurrence = occurrences.get(bullet.id) ?? 0; occurrences.set(bullet.id, occurrence + 1);
        // JSON encoding avoids collisions between arbitrary IDs, delimiters and duplicate occurrences.
        const key = JSON.stringify([name, bullet.id, occurrence]); wanted.add(key);
        let row = rows.get(key);
        if (!row) { row = makeRow(key, name === "blockers"); rows.set(key, row); }
        const status = planStatuses?.[index]; const hasDetails = Boolean(bullet.details);
        setText(row.title, bullet.text); setText(row.body, bullet.details ?? "");
        setText(row.status, status ? statuses[status].label : ""); row.status.hidden = !status;
        setText(row.marker, status ? statuses[status].marker : name === "next" ? String(index + 1) : name === "blockers" ? "!" : "·");
        row.li.dataset.status = status ?? (name === "blockers" ? "blocked" : "");
        row.disclosure.hidden = !hasDetails; row.plain.hidden = hasDetails; row.arrow.style.display = hasDetails ? "" : "none";
        const parent = hasDetails ? row.summary : row.plain;
        if (row.caption.parentElement !== parent) parent.append(row.caption);
        if (row.li !== cursor) group.list.insertBefore(row.li, cursor);
        cursor = row.li.nextElementSibling;
      });
      for (const [key, row] of rows) {
        if (row.li.parentElement === group.list && !wanted.has(key)) { row.disclosure.ontoggle = null; row.li.remove(); rows.delete(key); }
      }
      group.element.hidden = values.length === 0; setText(group.count, String(values.length));
    }
    const render = (value: unknown, revision: number) => {
      if (stopped || !acceptsRevision(latest, revision)) return; latest = revision;
      const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
      const model = contextViewModel(value, revision);
      setText(revisionLabel, model.state === "empty" ? "Not published" : `Revision ${model.revision}`);
      guidance.hidden = model.state !== "empty"; unavailable.hidden = model.state !== "error";
      content.hidden = clear.hidden = blockers.element.hidden = model.state !== "ready";
      if (model.state !== "ready") { setText(goal, model.state === "empty" ? "No context yet" : "Context unavailable"); return; }
      setText(goal, model.goal);
      renderList(plan, "plan", model.planItems, model.planItems.map((item) => item.status));
      renderList(next, "next", model.nextSteps); renderList(decisions, "decisions", model.decisions); renderList(blockers, "blockers", model.blockers);
      clear.hidden = model.blockers.length > 0;
      const completed = model.planItems.filter((item) => item.status === "complete").length;
      progress.max = Math.max(1, model.planItems.length); progress.value = completed;
      progress.setAttribute("aria-valuetext", `${completed} of ${model.planItems.length} items complete, reported by the agent`);
      setText(plan.count, `${completed} / ${model.planItems.length} done`);
      if (active?.isConnected && active.getClientRects().length && document.activeElement !== active) active.focus({ preventScroll: true });
    };
    // No revision callback yet is loading, not an assertion that the document is empty.
    setText(goal, "Loading context…"); setText(revisionLabel, "Loading");
    guidance.hidden = unavailable.hidden = content.hidden = blockers.element.hidden = clear.hidden = true;
    const cleanup = () => {
      if (stopped) return; stopped = true; events.abort(); unsubscribe();
      for (const row of rows.values()) row.disclosure.ontoggle = null;
    };
    context.signal.addEventListener("abort", cleanup, { once: true });
    if (context.signal.aborted) cleanup();
    else {
      try { const release = context.documents.subscribe("context", render); if (stopped) release(); else unsubscribe = release; }
      catch { render(undefined, 0); }
    }
    return { setVisible(visible) { if (!stopped) root.hidden = !visible; }, dispose() { cleanup(); context.signal.removeEventListener("abort", cleanup); root.remove(); } };
  },
};

export default function register(host: ExtensionRegistrationHost): void {
  host.registerContextView(view);
}
