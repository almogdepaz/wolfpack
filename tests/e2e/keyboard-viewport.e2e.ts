import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

const selectors = ['html', 'body', 'body > header', '#view-container', '#terminal-view', '#workspace-shell', '#workspace-terminal-region', '#desktop-terminal-container', '#kb-accessory', '#mobile-tab-bar'];
const properties = ['display', 'position', 'top', 'bottom', 'height', 'min-height', 'max-height', 'width', 'box-sizing', 'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom', 'border-top-width', 'border-bottom-width', 'flex', 'flex-direction', 'gap', 'overflow', 'transform', 'contain', 'backdrop-filter'];

async function sample(page: Page) {
  return page.evaluate(({ selectors, properties }) => {
    const elements = Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const style = getComputedStyle(element);
      const rules: string[] = [];
      const visit = (entries: CSSRuleList) => {
        for (const rule of entries) {
          if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
          if (rule instanceof CSSStyleRule && element.matches(rule.selectorText) && properties.some(property => rule.style.getPropertyValue(property))) rules.push(rule.cssText);
          if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      return [selector, { rect: element.getBoundingClientRect().toJSON(), style: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])), inline: element.getAttribute('style'), scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, rules }];
    }));
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
    const safeArea = getComputedStyle(probe).padding;
    probe.remove();
    return { innerHeight, clientHeight: document.documentElement.clientHeight, scrollY, vv: { height: visualViewport!.height, offsetTop: visualViewport!.offsetTop }, safeArea, elements };
  }, { selectors, properties });
}

for (const model of [{ width: 375, height: 667, keyboard: 400, safeArea: 0 }, { width: 390, height: 844, keyboard: 500, safeArea: 0 }, { width: 390, height: 844, keyboard: 500, safeArea: 34 }]) {
  const fixture = `${model.width}${model.safeArea ? '-safe34' : ''}`;
  test(`main parity mobile frame ${fixture}`, async ({ page, browser }, info) => {
    test.skip(info.project.name === 'desktop', 'mobile visualViewport regression');
    await page.setViewportSize({ width: model.width, height: model.height });
    // Use the existing user preference so entry-swipe animation cannot race
    // browser focus scrolling while comparing stable keyboard frames.
    await page.addInitScript(() => localStorage.setItem('wp-effects', JSON.stringify({ animations: false })));
    await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
      if (typeof message !== 'string' || JSON.parse(message).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'attach_ack' }));
      socket.send(Buffer.from('\x1b[2J\x1b[Hparity> '));
      socket.send(JSON.stringify({ type: 'prefill_done' }));
      socket.send(JSON.stringify({ type: 'pty_ready' }));
    }));
    await page.goto(server.baseUrl + '?kbdebug=1');
    const hashes: Record<string, string> = {};
    for (const file of ['app.bundle.js', 'styles.css']) {
      const url = await page.evaluate(file => {
        const element = document.querySelector<HTMLScriptElement | HTMLLinkElement>(`[src*="/${file}"], [href*="/${file}"]`)!;
        return element instanceof HTMLScriptElement ? element.src : element.href;
      }, file);
      const response = await page.request.get(url);
      expect(response.ok()).toBe(true);
      const bytes = await response.body();
      expect(bytes.equals(await readFile(new URL(`../../public/${file}`, import.meta.url)))).toBe(true);
      hashes[file] = createHash('sha256').update(bytes).digest('hex');
    }
    await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
    const input = page.locator('#desktop-terminal-container textarea');
    await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
    await expect(page.locator('#terminal-view')).not.toHaveClass(/swiping/);
    await expect(input).toHaveAttribute('inputmode', 'none');
    if (model.safeArea) await page.evaluate(inset => {
      // Model only the env() value at its actual consuming main rule;
      // do not change positioning, frame dimensions or keyboard-state rules.
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && rule.selectorText === '#terminal-view' && rule.style.paddingBottom.includes('env(safe-area-inset-bottom)')) rule.style.paddingBottom = `${inset}px`;
          if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
    }, model.safeArea);
    const samples: Record<string, Awaited<ReturnType<typeof sample>>> = {};
    for (const [name, height, offsetTop] of [['closed', model.height, 0], ['open', model.keyboard, 0], ['panned', model.keyboard, 40], ['closed-again', model.height, 0]] as const) {
      if (name === 'open') await page.locator('#kb-open-btn').click();
      await page.evaluate(({ height, offsetTop }) => {
        Object.defineProperties(visualViewport!, { height: { configurable: true, value: height }, offsetTop: { configurable: true, value: offsetTop } });
        visualViewport!.dispatchEvent(new Event('resize'));
        visualViewport!.dispatchEvent(new Event('scroll'));
      }, { height, offsetTop });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      samples[name] = await sample(page);
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
    }
    await writeFile(info.outputPath('rects.json'), JSON.stringify({ model, browser: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), deviceScaleFactor: await page.evaluate(() => devicePixelRatio), hashes, samples }, null, 2));
    // Capture-only is used on the exact local main worktree; the same real
    // mobile browser, fixture, viewport events and sampling run on head.
    if (process.env.WOLFPACK_GEOMETRY_CAPTURE === '1') return;
    const baseline = JSON.parse(await readFile(new URL(`../fixtures/mobile-main-geometry-${fixture}.json`, import.meta.url), 'utf8')) as Record<string, Record<string, { top: number; bottom: number; left: number; right: number; height: number; width: number }>>;
    for (const [name, data] of Object.entries(samples)) {
      for (const selector of selectors) {
        for (const property of ['top', 'bottom', 'left', 'right', 'height', 'width'] as const) {
          expect.soft(data.elements[selector]!.rect[property], `${name} ${selector} ${property} matches main`).toBeCloseTo(baseline[name]![selector]?.[property] ?? 0, 1);
        }
      }
      expect.soft(data.elements['#mobile-tab-bar']!.style.display).toBe('none');
      if (name === 'open' || name === 'panned') {
        expect.soft(data.elements['#kb-accessory']!.rect.bottom, 'accessory meets visual viewport bottom (or main modeled safe-area edge)').toBeCloseTo(data.vv.height + data.vv.offsetTop - model.safeArea, 1);
      }
    }
    await expect(page.locator('#kb-debug')).toHaveCount(0);
    await expect(input).toHaveAttribute('inputmode', 'none');
    await page.locator('#back-btn').click();
    await expect(page.locator('#terminal-view')).toHaveCSS('bottom', '0px');
  });
}
