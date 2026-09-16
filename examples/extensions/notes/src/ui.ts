import { verticalStackLayout, type ExtensionRegistrationHost } from "wolfpack-bridge/extensions";

export default function register(host: ExtensionRegistrationHost): void {
  host.registerContextView({
    id: "notes",
    title: "Notes",
    mount(container, context) {
      const root = document.createElement("section");
      const label = document.createElement("label"); label.textContent = "Local notes for this exact extension scope";
      const editor = document.createElement("textarea"); editor.value = context.storage.get("notes") ?? "";
      editor.addEventListener("input", () => context.storage.set("notes", editor.value));
      label.append(editor); root.append(label); container.replaceChildren(root);
      return { setVisible(visible) { root.hidden = !visible; }, dispose() { root.remove(); } };
    },
  });
  host.registerTerminalLayout({ id: "vertical-stack", title: "Vertical stack", arrange: verticalStackLayout });
}
