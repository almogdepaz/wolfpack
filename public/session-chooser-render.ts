/** Preserve chooser focus by exact identity; never redirect it to a reused name. */
export function replaceSessionChooserHtml(element: HTMLElement, html: string): void {
  const active = document.activeElement;
  const control = active instanceof HTMLButtonElement && element.contains(active) ? active : null;
  const view = control?.dataset.sessionCardView;
  const action = control?.dataset.action;
  const card = control?.closest<HTMLElement>(".card");
  const sessionId = card?.dataset.sessionOrderId;
  const machine = card?.dataset.sessionOrderMachine;
  const scrollTop = element.scrollTop;
  element.innerHTML = html;
  element.scrollTop = scrollTop;
  if (!control) return;
  const replacement = Array.from(element.querySelectorAll<HTMLButtonElement>("button[data-action]")).find(button => {
    if (view) return button.dataset.sessionCardView === view;
    const currentCard = button.closest<HTMLElement>(".card");
    return Boolean(sessionId) && button.dataset.action === action
      && currentCard?.dataset.sessionOrderId === sessionId
      && currentCard?.dataset.sessionOrderMachine === machine;
  });
  replacement?.focus({ preventScroll: true });
}
