/** Relocate chrome only: one owner per control, no terminal or extension remount. */
export function initWorkspaceNavigation(): void {
  const byId = (id: string) => document.getElementById(id);
  const toolbar = document.querySelector(".workspace-terminal-toolbar")!;
  const controls = Array.from(toolbar.children, node => ({
    node: node as HTMLElement,
    mobileLabel: node.getAttribute("aria-label")!,
  }));
  const dialog = byId("workspace-settings-dialog") as HTMLDialogElement;
  const actions = byId("workspace-session-actions") as HTMLDetailsElement;
  const media = matchMedia("(min-width:769px)");
  const sync = () => {
    if (!media.matches) {
      dialog.close();
      actions.open = false;
    }
    controls.forEach(({ node, mobileLabel }) => {
      (media.matches ? byId(node.dataset.desktopHost!)! : toolbar).append(node);
      node.setAttribute("aria-label", media.matches ? node.querySelector(".workspace-control-label")?.textContent || mobileLabel : mobileLabel);
    });
  };
  media.addEventListener("change", sync);
  sync();
  byId("workspace-settings-btn")!.addEventListener("click", () => {
    (byId("workspace-layout-setting") as HTMLFieldSetElement).disabled = byId("workspace-shell")!.dataset.fullView === "context";
    dialog.showModal();
  });
  // Native Escape still closes the dialog, without escaping a focused delegation.
  dialog.addEventListener("keydown", event => event.stopPropagation());
  actions.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    actions.open = false;
    actions.querySelector("summary")!.focus();
  });
}
