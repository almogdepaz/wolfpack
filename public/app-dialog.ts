export interface AppDialogField {
  readonly name: string;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
}

export interface AppDialogOptions {
  readonly title: string;
  readonly message?: string;
  readonly fields?: readonly AppDialogField[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string | null;
  readonly destructive?: boolean;
  /** Host scope cancellation: never retain a credential/trust modal after selection changes. */
  readonly signal?: AbortSignal;
}

export type AppDialogResult = Readonly<Record<string, string>> | null;

let activeDialog: { readonly element: HTMLDialogElement; readonly closed: Promise<void> } | null = null;

export function showAppDialog(options: AppDialogOptions): Promise<AppDialogResult> {
  if (options.signal?.aborted) return Promise.resolve(null);
  const dialog = document.getElementById("app-dialog");
  const form = document.getElementById("app-dialog-form");
  const title = document.getElementById("app-dialog-title");
  const message = document.getElementById("app-dialog-message");
  const fields = document.getElementById("app-dialog-fields");
  const cancel = document.getElementById("app-dialog-cancel");
  const confirm = document.getElementById("app-dialog-confirm");
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !(form instanceof HTMLFormElement) ||
    !(title instanceof HTMLElement) ||
    !(message instanceof HTMLElement) ||
    !(fields instanceof HTMLElement) ||
    !(cancel instanceof HTMLButtonElement) ||
    !(confirm instanceof HTMLButtonElement)
  ) {
    throw new Error("missing required app dialog elements");
  }
  if (activeDialog) {
    // Native close events are queued. Do not let an old event settle a newly
    // opened modal or remove its handlers; wait only while the owner is closing.
    if (!activeDialog.element.open) return activeDialog.closed.then(() => showAppDialog(options));
    return Promise.reject(new Error("app dialog is busy"));
  }
  if (dialog.open) return Promise.reject(new Error("app dialog is busy"));
  const focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  title.textContent = options.title;
  message.textContent = options.message || "";
  message.hidden = !options.message;
  fields.replaceChildren();

  for (const field of options.fields || []) {
    const label = document.createElement("label");
    label.className = "app-dialog-field";
    const labelText = document.createElement("span");
    labelText.textContent = field.label;
    const input = document.createElement("input");
    input.name = field.name;
    input.value = field.value || "";
    input.placeholder = field.placeholder || "";
    input.autocomplete = "off";
    input.required = true;
    input.addEventListener("input", () => input.setCustomValidity(""));
    label.append(labelText, input);
    fields.append(label);
  }

  cancel.textContent = options.cancelLabel || "Cancel";
  cancel.hidden = options.cancelLabel === null;
  confirm.textContent = options.confirmLabel;
  confirm.classList.toggle("destructive", options.destructive === true);

  let releaseOwner!: () => void;
  const owner = { element: dialog, closed: new Promise<void>(resolve => { releaseOwner = resolve; }) };
  activeDialog = owner;
  return new Promise((resolve) => {
    let submittedValues: Readonly<Record<string, string>> | null = null;

    const cleanup = (): void => {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      const inputs = [...fields.querySelectorAll<HTMLInputElement>("input")];
      const blankInput = inputs.find((input) => !input.value.trim());
      if (blankInput) {
        blankInput.setCustomValidity("Enter a value");
        blankInput.reportValidity();
        blankInput.focus({ preventScroll: true });
        return;
      }
      if (!form.reportValidity()) return;
      const values: Record<string, string> = {};
      for (const [name, value] of new FormData(form).entries()) {
        if (typeof value === "string") values[name] = value.trim();
      }
      submittedValues = values;
      dialog.close("confirm");
    };
    const onCancel = (): void => dialog.close("cancel");
    const onAbort = (): void => dialog.close("cancel");
    const onClose = (): void => {
      cleanup();
      if (activeDialog === owner) activeDialog = null;
      releaseOwner();
      resolve(!options.signal?.aborted && dialog.returnValue === "confirm" ? submittedValues : null);
      if (!options.signal?.aborted) focusReturn?.focus({ preventScroll: true });
    };

    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try { dialog.showModal(); }
    catch (error) {
      cleanup();
      if (activeDialog === owner) activeDialog = null;
      releaseOwner();
      throw error;
    }
    if (options.signal?.aborted) { onAbort(); return; }
    const firstInput = fields.querySelector<HTMLInputElement>("input");
    (firstInput || confirm).focus({ preventScroll: true });
  });
}
