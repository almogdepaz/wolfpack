(() => {
  if (window.innerWidth <= 768) return;
  const storedPinned = localStorage.getItem("wolfpack-sidebar-pinned");
  const pinned = storedPinned === null
    ? localStorage.getItem("wolfpack-sidebar-collapsed") !== "1"
    : storedPinned !== "0";
  const sidebar = document.getElementById("desktop-sidebar");
  sidebar.style.transition = "none";
  sidebar.classList.toggle("collapsed", !pinned);
  sidebar.toggleAttribute("inert", !pinned);
  sidebar.setAttribute("aria-hidden", String(!pinned));
  document.body.classList.toggle("sidebar-pinned", pinned);
  void sidebar.offsetWidth;
  sidebar.style.removeProperty("transition");
})();
