import { leadStackLayout, type ContextViewContribution, type ExtensionRegistrationHost, type ExtensionViewContext } from "wolfpack-bridge/extensions";
import { acceptsRevision, contextViewModel } from "./model.ts";

function text(tag: string, value = ""): HTMLElement { const node = document.createElement(tag); node.textContent = value; return node; }
function list(container: HTMLElement, values: readonly string[]): void { container.replaceChildren(...values.map((value) => text("li", value))); }

const view: ContextViewContribution = {
  id: "context",
  title: "Agent Context",
  mount(container, context) {
    const root = document.createElement("section"); root.className = "wolfpack-agent-context";
    const provenance = text("p", "Agent-authored context — not verified task or execution evidence.");
    const scope = text("p"); const goal = text("h2");
    const guidance = text("p", `Ask your agent to use the wolfpack-agent-context skill and publish to session ${context.scope.sessionId}. Context is not extracted automatically from terminal output.`);
    const plan = document.createElement("ul"); const decisions = document.createElement("ul"); const blockers = document.createElement("ul"); const nextSteps = document.createElement("ul");
    const draft = document.createElement("textarea"); draft.placeholder = "Local draft (not published)"; draft.value = context.storage.get("draft") ?? "";
    draft.addEventListener("input", () => context.storage.set("draft", draft.value));
    root.append(provenance, scope, goal, guidance, text("h3", "Plan"), plan, text("h3", "Decisions"), decisions, text("h3", "Blockers"), blockers, text("h3", "Next steps"), nextSteps, draft);
    container.replaceChildren(root);
    let latest = -1; let stopped = false;
    const render = (value: unknown, revision: number) => {
      if (stopped || !acceptsRevision(latest, revision)) return; latest = revision;
      const model = contextViewModel(value, revision);
      scope.textContent = `Scope ${context.scope.sessionId} · revision ${model.revision}`;
      guidance.hidden = model.state !== "empty";
      if (model.state === "empty") { goal.textContent = "No context has been published for this exact scope."; list(plan, []); list(decisions, []); list(blockers, []); list(nextSteps, []); return; }
      if (model.state === "error") { goal.textContent = "Published context is unavailable or invalid."; list(plan, []); list(decisions, []); list(blockers, []); list(nextSteps, []); return; }
      goal.textContent = model.goal; list(plan, model.planItems.map((item) => `${item.status}: ${item.text}`)); list(decisions, model.decisions); list(blockers, model.blockers); list(nextSteps, model.nextSteps);
    };
    let unsubscribe = () => {};
    try { unsubscribe = context.documents.subscribe("context", render); }
    catch { render(undefined, 0); }
    let released = false;
    const cleanup = () => { if (released) return; released = true; stopped = true; unsubscribe(); };
    context.signal.addEventListener("abort", cleanup, { once: true });
    return { setVisible(visible) { root.hidden = !visible; }, dispose() { cleanup(); context.signal.removeEventListener("abort", cleanup); root.remove(); } };
  },
};

export default function register(host: ExtensionRegistrationHost): void {
  host.registerContextView(view);
  host.registerTerminalLayout({ id: "lead-stack", title: "Lead + stack", arrange: leadStackLayout });
}
