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
}

export type AppDialogResult = Readonly<Record<string, string>> | null;

export function showAppDialog(options: AppDialogOptions): Promise<AppDialogResult> {
  const dialog = document.getElementById("app-dialog") as HTMLDialogElement;
  const form = document.getElementById("app-dialog-form") as HTMLFormElement;
  const title = document.getElementById("app-dialog-title");
  const message = document.getElementById("app-dialog-message");
  const fields = document.getElementById("app-dialog-fields");
  const cancel = document.getElementById("app-dialog-cancel") as HTMLButtonElement;
  const confirm = document.getElementById("app-dialog-confirm") as HTMLButtonElement;
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

  return new Promise((resolve) => {
    let submittedValues: Readonly<Record<string, string>> | null = null;

    const cleanup = (): void => {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
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
    const onClose = (): void => {
      cleanup();
      resolve(dialog.returnValue === "confirm" ? submittedValues : null);
      focusReturn?.focus({ preventScroll: true });
    };

    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    const firstInput = fields.querySelector<HTMLInputElement>("input");
    (firstInput || confirm).focus({ preventScroll: true });
  });
}
