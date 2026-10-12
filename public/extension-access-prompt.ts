import type { AppDialogOptions, AppDialogResult } from "./app-dialog.ts";

/** Passive extension-only access UI. Never focuses or makes the workspace inert. */
export function createExtensionAccessPrompt(container: HTMLElement | null, onGeometryChange: () => void): (options: AppDialogOptions) => Promise<AppDialogResult> {
  return options => {
    const target = container;
    if (!target) return Promise.reject(new Error("extension permission presentation unavailable"));
    if (options.signal?.aborted) return Promise.resolve(null);
    return new Promise<AppDialogResult>(resolve => {
      const form = document.createElement("form");
      form.className = "extension-access-prompt";
      form.setAttribute("aria-label", options.title);
      const title = document.createElement("strong"), message = document.createElement("p");
      title.textContent = options.title; message.textContent = options.message ?? "";
      message.setAttribute("role", "status");
      form.append(title, message);
      const fields = (options.fields ?? []).map(field => {
        const label = document.createElement("label"), input = document.createElement("input");
        label.textContent = field.label;
        input.name = field.name; input.type = "password"; input.autocomplete = "off";
        input.spellcheck = false; input.placeholder = field.placeholder ?? "";
        input.value = field.value ?? "";
        label.append(input); form.append(label);
        return input;
      });
      const confirm = document.createElement("button"), cancel = document.createElement("button");
      confirm.type = "submit"; confirm.textContent = options.confirmLabel;
      cancel.type = "button"; cancel.textContent = options.cancelLabel ?? "Not now";
      form.append(confirm, cancel);
      let settled = false;
      const finish = (result: AppDialogResult): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        form.removeEventListener("submit", submit); cancel.removeEventListener("click", abort);
        form.remove(); for (const input of fields) input.value = "";
        target.hidden = target.childElementCount === 0;
        onGeometryChange(); resolve(result);
      };
      const abort = (): void => finish(null);
      const submit = (event: Event): void => {
        event.preventDefault();
        finish(Object.fromEntries(fields.map(input => [input.name, input.value])));
      };
      form.addEventListener("submit", submit);
      cancel.addEventListener("click", abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      target.append(form); target.hidden = false; onGeometryChange();
    });
  };
}
