export interface DelegatedAppActions {
  quickSend(index: number): void;
  quickMove(index: number, offset: -1 | 1): void;
  quickEdit(index: number): void;
  quickDelete(index: number): void;
  delegationToggle(key: string, event: MouseEvent): void;
  newSession(machine?: string): void;
  openSession(session: string, machine?: string): void;
  killSession(session: string, event: MouseEvent, machine?: string): void;
  retryMachine(machine: string, event: MouseEvent): void;
  selectProject(project: string): void;
  agentRemove(command: string): void;
  createAgentSession(command: string): void;
  agentToggle(command: string, enabled: boolean): void;
  toggleGrid(session: string, machine: string, event: MouseEvent): void;
}

/** Owns dynamic data-action dispatch so the app facade does not accumulate per-render listeners. */
export function bindDelegatedAppActions(root: Document, actions: DelegatedAppActions): () => void {
  const click = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const machine = button.dataset.machine || undefined;
    const session = button.dataset.session;
    const index = Number(button.dataset.index);
    if (action === "quick-send" && Number.isInteger(index)) actions.quickSend(index);
    else if (action === "quick-move" && Number.isInteger(index)) actions.quickMove(index, button.dataset.offset === "-1" ? -1 : 1);
    else if (action === "quick-edit" && Number.isInteger(index)) actions.quickEdit(index);
    else if (action === "quick-delete" && Number.isInteger(index)) actions.quickDelete(index);
    else if (action === "delegation-toggle" && button.dataset.delegationKey) actions.delegationToggle(button.dataset.delegationKey, event);
    else if (action === "new-session") actions.newSession(machine);
    else if (action === "open-session" && session) actions.openSession(session, machine);
    else if (action === "kill-session" && session) actions.killSession(session, event, machine);
    else if (action === "retry-machine") actions.retryMachine(machine || "", event);
    else if (action === "select-project" && button.dataset.project) actions.selectProject(button.dataset.project);
    else if (action === "agent-remove" && button.dataset.command) actions.agentRemove(button.dataset.command);
    else if (action === "create-agent-session" && button.dataset.command) actions.createAgentSession(button.dataset.command);
    else if (action === "toggle-grid" && session) actions.toggleGrid(session, machine || "", event);
  };
  const change = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.action !== "agent-toggle") return;
    if (target.dataset.command) actions.agentToggle(target.dataset.command, target.checked);
  };
  root.addEventListener("click", click);
  root.addEventListener("change", change);
  return () => {
    root.removeEventListener("click", click);
    root.removeEventListener("change", change);
  };
}
