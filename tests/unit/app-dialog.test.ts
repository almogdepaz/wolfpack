import { afterEach, describe, expect, test } from "bun:test";
import { showAppDialog } from "../../public/app-dialog.ts";

class Element extends EventTarget {
  textContent = ""; hidden = false; focusCalls = 0;
  classList = { toggle() {} };
  replaceChildren() {};
  querySelector() { return null; }
  focus() { this.focusCalls++; }
}
class Form extends Element {}
class Button extends Element {}
class Dialog extends Element {
  open = false; returnValue = "";
  showModal() { if (this.open) throw new Error("already open"); this.open = true; }
  close(value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new Event("close")); }
}
const saved = new Map<string, unknown>();
function installDialog(): { dialog: Dialog; title: Element; focused: Element } {
  const dialog = new Dialog(), title = new Element(), focused = new Element();
  const elements: Record<string, Element> = {
    "app-dialog": dialog, "app-dialog-form": new Form(), "app-dialog-title": title,
    "app-dialog-message": new Element(), "app-dialog-fields": new Element(),
    "app-dialog-cancel": new Button(), "app-dialog-confirm": new Button(),
  };
  const globals: Record<string, unknown> = { HTMLDialogElement: Dialog, HTMLFormElement: Form, HTMLElement: Element, HTMLButtonElement: Button,
    document: { activeElement: focused, getElementById: (id: string) => elements[id] },
  };
  for (const [key, value] of Object.entries(globals)) { saved.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  return { dialog, title, focused };
}
afterEach(() => { for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value; saved.clear(); });
const options = { title: "Trust peer code?", confirmLabel: "Trust" };
describe("cancellable host dialog", () => {
  test("scope abort closes and settles its modal without restoring obsolete focus", async () => {
    const { dialog, focused } = installDialog();
    const controller = new AbortController();
    const result = showAppDialog({ ...options, signal: controller.signal });
    expect(dialog.open).toBe(true);
    controller.abort();
    expect(dialog.open).toBe(false);
    expect(await result).toBeNull();
    expect(focused.focusCalls).toBe(0);
  });
  test("already-aborted scopes never open a modal", async () => {
    const { dialog } = installDialog();
    expect(await showAppDialog({ ...options, signal: AbortSignal.abort() })).toBeNull();
    expect(dialog.open).toBe(false);
  });
  test("does not overwrite another live dialog", async () => {
    const { dialog, title } = installDialog();
    dialog.open = true; title.textContent = "Existing workflow";
    await expect(showAppDialog(options)).rejects.toThrow("busy");
    expect(title.textContent).toBe("Existing workflow"); expect(dialog.open).toBe(true);
  });
});
