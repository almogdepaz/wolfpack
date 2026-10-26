// Web fonts load without blocking first paint: the stylesheet starts as
// media="print" and is applied here; until then the declared fallbacks render.
for (const link of document.querySelectorAll('link[data-deferred-style]')) link.media = 'all';

// Copy buttons for the install commands.
for (const button of document.querySelectorAll('[data-copy-command]')) {
  button.addEventListener('click', async () => {
    const status = document.getElementById(button.getAttribute('aria-describedby'));
    const command = button.getAttribute('data-copy-command');
    const label = button.getAttribute('data-copy-label');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      status.textContent = `Copied ${label} command.`;
    } catch {
      status.textContent = 'Copy failed. Select the visible command and copy it manually.';
    }
  });
}

// Tabs: [data-tabs] holds .tab-panel figures. Without JS they stay a plain
// list. On narrow screens they become a swipeable row (a focusable, labelled
// scroll region). On wide screens they become an ARIA tablist with
// arrow/Home/End keys. Inactive panels stay laid out (transparent and inert)
// so their lazy images still load and the layout does not jump.
const wide = window.matchMedia('(min-width: 761px)');
let tabsId = 0;
for (const tabs of document.querySelectorAll('[data-tabs]')) {
  const panels = [...tabs.querySelectorAll(':scope > .tab-panel')];
  const groupId = `tabs-${++tabsId}`;
  const list = document.createElement('div');
  list.className = 'tab-list';
  const wrapper = document.createElement('div');
  wrapper.className = 'tab-panels';
  panels[0].before(list);
  list.after(wrapper);
  wrapper.append(...panels);
  const buttons = panels.map((panel, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${groupId}-tab-${index}`;
    button.textContent = panel.querySelector('h3').textContent;
    panel.id = `${groupId}-panel-${index}`;
    list.append(button);
    return button;
  });
  let active = 0;
  const select = (index, focus) => {
    active = (index + panels.length) % panels.length;
    buttons.forEach((button, i) => {
      const selected = i === active;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panels[i].dataset.active = String(selected);
      panels[i].inert = !selected;
      panels[i].setAttribute('aria-hidden', String(!selected));
    });
    if (focus) buttons[active].focus();
  };
  const enable = () => {
    tabs.classList.add('tabs-on');
    for (const name of ['role', 'aria-label', 'tabindex']) wrapper.removeAttribute(name);
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', tabs.getAttribute('data-tabs'));
    buttons.forEach((button, i) => {
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', panels[i].id);
      panels[i].setAttribute('role', 'tabpanel');
      panels[i].setAttribute('aria-labelledby', button.id);
    });
    select(active, false);
  };
  const disable = () => {
    tabs.classList.remove('tabs-on');
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', tabs.getAttribute('data-tabs'));
    wrapper.tabIndex = 0;
    list.removeAttribute('role');
    list.removeAttribute('aria-label');
    buttons.forEach((button, i) => {
      for (const name of ['role', 'aria-controls', 'aria-selected']) button.removeAttribute(name);
      button.tabIndex = -1;
      for (const name of ['role', 'aria-labelledby', 'aria-hidden', 'data-active']) panels[i].removeAttribute(name);
      panels[i].inert = false;
    });
  };
  buttons.forEach((button, i) => button.addEventListener('click', () => select(i, false)));
  list.addEventListener('keydown', (event) => {
    if (!tabs.classList.contains('tabs-on')) return;
    const focused = buttons.indexOf(document.activeElement);
    const from = focused >= 0 ? focused : active;
    const keys = { ArrowRight: from + 1, ArrowDown: from + 1, ArrowLeft: from - 1, ArrowUp: from - 1, Home: 0, End: panels.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    select(keys[event.key], true);
  });
  const sync = () => (wide.matches ? enable() : disable());
  wide.addEventListener('change', sync);
  sync();
}

// Code cards scroll sideways only when a line is wider than the card (desktop
// keeps whole lines; phones wrap at spaces). Only overflowing cards join the
// tab order, so keyboard users can scroll exactly the ones that need it.
const codeCards = [...document.querySelectorAll('.code-card')];
const syncCodeCardFocus = () => {
  for (const card of codeCards) {
    if (card.scrollWidth > card.clientWidth + 1) card.tabIndex = 0;
    else card.removeAttribute('tabindex');
  }
};
let codeCardFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(codeCardFrame);
  codeCardFrame = requestAnimationFrame(syncCodeCardFocus);
});
if (document.fonts) document.fonts.ready.then(syncCodeCardFocus);
syncCodeCardFocus();
