/** Move only the two widget controls; stable rows survive session-list renders. */
export function initWorkspaceNavigation(): (sidebarOwns: boolean) => void {
  const toolbar = document.querySelector<HTMLElement>(".workspace-terminal-toolbar")!;
  const controls = Array.from(toolbar.children, node => ({
    node: node as HTMLElement,
    mobileLabel: node.getAttribute("aria-label")!,
  }));
  const media = matchMedia("(min-width:769px)");
  let sidebarOwns = false;
  const sync = () => {
    const host = media.matches
      ? document.getElementById(sidebarOwns ? "sidebar-widget-controls" : "dashboard-widget-controls")!
      : toolbar;
    controls.forEach(({ node, mobileLabel }) => {
      if (node.parentElement !== host) host.append(node);
      node.setAttribute("aria-label", media.matches ? node.querySelector(".workspace-control-label")!.textContent! : mobileLabel);
    });
  };
  media.addEventListener("change", sync);
  sync();
  return owns => { sidebarOwns = owns; sync(); };
}
