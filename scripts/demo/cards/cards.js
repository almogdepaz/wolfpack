// Timeline for demo cards. Elements with data-step="<ms>" appear at that time;
// elements with data-type="<ms-per-char>" also type their text in. When the
// last step finished, body[data-done] is set so the recorder can stop waiting.
(() => {
  const steps = [...document.querySelectorAll("[data-step]")].map((element) => ({
    element,
    at: Number(element.dataset.step),
    perChar: element.dataset.type ? Number(element.dataset.type) : 0,
    text: element.dataset.type ? element.textContent : "",
  }));
  for (const step of steps) if (step.perChar) step.element.textContent = "";
  const typeInto = (step) => new Promise((resolve) => {
    step.element.classList.add("caret");
    let index = 0;
    const tick = () => {
      index += 1;
      step.element.textContent = step.text.slice(0, index);
      if (index < step.text.length) setTimeout(tick, step.perChar);
      else { step.element.classList.remove("caret"); resolve(); }
    };
    tick();
  });
  const start = () => {
    const finishes = steps.map((step) => new Promise((resolve) => setTimeout(() => {
      step.element.classList.add("shown");
      if (step.perChar) typeInto(step).then(resolve); else setTimeout(resolve, 450);
    }, step.at)));
    const hold = Number(document.body.dataset.hold || 0);
    Promise.all(finishes).then(() => setTimeout(() => { document.body.dataset.done = "1"; }, hold));
  };
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(start);
})();
