import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: ['nav-project'] } }));
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card').first()).toBeVisible();
});

for (const width of [320, 375, 390]) test(`Sessions New reuses delegated project and agent flow and restores focus at ${width}`, async ({ page }, info) => {
  if (info.project.name !== 'desktop') await page.setViewportSize({ width, height: 844 });
  const trigger = info.project.name === 'desktop' ? page.locator('.new-session-primary') : page.locator('#session-list .machine-add-btn');
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('data-action', 'new-session');
  await trigger.click();
  await expect(page.locator('#projects-view')).toHaveClass(/visible/);
  await expect(page.locator('#new-project-name')).toBeFocused();
  await page.getByRole('button', { name: 'Open project nav-project', exact: true }).click();
  await expect(page.locator('#agent-view')).toHaveClass(/visible/);
  await expect(page.locator('#session-name-input')).toBeVisible();
  if (info.project.name !== 'desktop') {
    await page.locator('#back-btn').click();
    await expect(page.locator('#projects-view')).toHaveClass(/visible/);
    await page.locator('#back-btn').click();
    await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('#back-btn').click();
    await expect(trigger).toBeFocused();
  }
});

// Per-machine creation remains available in both states without a duplicate
// mobile global action, and neither creation nor return changes collapse state.
for (const width of [320, 375, 390]) for (const collapsed of [false, true]) {
  test(`per-machine creation prerequisite ${collapsed ? 'collapsed' : 'expanded'} at ${width}`, async ({ page }, info) => {
    test.skip(info.project.name === 'desktop', 'mobile prerequisite');
    await page.setViewportSize({ width, height: 844 });
    const groups = page.locator('#session-list .machine-group[data-machine]');
    await expect(groups).toHaveCount(1);
    const group = groups.first();
    await expect(group).toHaveAttribute('data-machine', '');
    await expect(group.locator('.dot[title="online"]')).toBeVisible();
    const machineName = (await group.locator('.machine-header-name').textContent())?.trim();
    expect(machineName).toBeTruthy();
    const requests: string[] = [];
    page.on('request', request => {
      if (/^\/api\/(projects|agents)$/.test(new URL(request.url()).pathname)) requests.push(request.url());
    });
    await expect.soft(page.locator('.new-session-primary')).toBeHidden();
    if (collapsed) {
      await group.getByRole('button', { name: `Collapse ${machineName}`, exact: true }).click();
      await expect(group.getByRole('button', { name: `Expand ${machineName}`, exact: true })).toBeFocused();
      await expect(group.locator('.machine-group-body')).toHaveAttribute('hidden', '');
      await expect(group.locator('.machine-group-body')).toHaveAttribute('inert', '');
    }
    const snapshot = await group.evaluate(element => ({
      html: element.outerHTML,
      controls: [...element.querySelectorAll('button')].map(button => ({
        label: button.getAttribute('aria-label'), action: button.dataset.action,
        rect: button.getBoundingClientRect().toJSON(),
        visible: button.checkVisibility(), disabled: button.disabled,
      })),
      focus: document.activeElement?.outerHTML,
      globalNewVisible: document.querySelector('.new-session-primary')?.checkVisibility(),
      viewport: { width: innerWidth, height: innerHeight },
    }));
    writeFileSync(info.outputPath('gate.json'), JSON.stringify({ collapsed, machineName, ...snapshot }, null, 2));
    await page.screenshot({ path: info.outputPath('machine.png') });
    const trigger = group.getByRole('button', { name: `Start a session on ${machineName}`, exact: true });
    await expect(trigger, 'required per-machine creation must remain visible without expanding or using global New').toBeVisible();
    await expect(trigger).toBeEnabled();
    await expect(group.locator('.machine-header .machine-add-btn:visible')).toHaveCount(1);
    const header = await group.locator('.machine-header').boundingBox();
    const add = await trigger.boundingBox();
    const toggle = await group.locator('.machine-collapse-toggle').boundingBox();
    expect(header).not.toBeNull(); expect(add).not.toBeNull(); expect(toggle).not.toBeNull();
    expect.soft(add!.y + add!.height / 2).toBeCloseTo(toggle!.y + toggle!.height / 2, 0);
    expect.soft(add!.x).toBeGreaterThanOrEqual(header!.x);
    expect.soft(add!.x + add!.width).toBeLessThanOrEqual(width);
    await expect.soft(trigger.locator(':scope > span')).toBeHidden();
    if (width === 375) await trigger.press('Enter'); else await trigger.click();
    await expect(page.locator('#projects-view')).toHaveClass(/visible/);
    await expect(page.locator('#new-project-name')).toBeFocused();
    await page.getByRole('button', { name: 'Open project nav-project', exact: true }).click();
    await expect(page.locator('#agent-view')).toHaveClass(/visible/);
    await expect(page.locator('#session-name-input')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent.png') });
    await page.locator('#back-btn').click();
    await expect(page.locator('#projects-view')).toHaveClass(/visible/);
    await page.locator('#back-btn').click();
    await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
    await expect(trigger).toBeFocused();
    await expect(group.locator('.machine-collapse-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
    await trigger.click();
    await expect(page.locator('#projects-view')).toHaveClass(/visible/);
    await page.locator('#back-btn').click();
    await expect(trigger).toBeFocused();
    await expect(group.locator('.machine-collapse-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
    writeFileSync(info.outputPath('flow.json'), JSON.stringify({ requests, returnedFocus: await page.evaluate(() => document.activeElement?.outerHTML), collapsed, header, add, toggle }, null, 2));
    await page.screenshot({ path: info.outputPath('returned.png') });
  });
}

for (const collapsed of [false, true]) test(`machine header mode changes retain collapse state and desktop controls (${collapsed})`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop to mobile to desktop viewport mode');
  const group = page.locator('#session-list .machine-group[data-machine=""]');
  if (collapsed) await group.locator('.machine-collapse-toggle').click();
  const create = group.locator('.machine-header .machine-add-btn');
  await expect(create).toHaveCount(collapsed ? 0 : 1);
  await expect(page.locator('.new-session-primary')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(create).toHaveCount(1);
  await expect(create).toBeVisible();
  await expect(page.locator('.new-session-primary')).toBeHidden();
  await expect(group.locator('.machine-collapse-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(create).toHaveCount(collapsed ? 0 : 1);
  await expect(page.locator('.new-session-primary')).toBeVisible();
  await expect(group.locator('.machine-collapse-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
});

test('mobile Settings destination retains navigation and return focus', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile navigation only');
  const settings = page.locator('#mobile-settings');
  await settings.focus(); await settings.press('Enter');
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await expect(settings).toHaveCSS('color', 'rgb(69, 237, 126)');
  await expect(page.locator('#mobile-sessions')).toHaveCSS('color', 'rgb(127, 144, 135)');
  await expect(page.locator('#back-btn')).toBeFocused();
  await page.getByRole('link', { name: 'Machines', exact: true }).click();
  await expect(page.locator('#settings-machines')).toBeInViewport();
  await expect(page).toHaveURL(/#settings-machines$/);
  await page.locator('#back-btn').click();
  await expect(settings).toBeFocused();
  await page.locator('#mobile-sessions').click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
});

test('terminal Back still reaches Settings without adding navigation below the accessory', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile terminal route');
  await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
  await expect(page.locator('#mobile-tab-bar')).toBeHidden();
  await expect(page.locator('#gear-btn')).toBeHidden();
  await page.locator('#kb-open-btn').click();
  await expect(page.locator('#desktop-terminal-container textarea')).toBeFocused();
  await expect(page.locator('#mobile-tab-bar')).toBeHidden();
  await page.locator('#back-btn').click();
  await page.locator('#mobile-settings').click();
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await page.getByRole('link', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Extra large 18px' })).toBeVisible();
});

test('desktop keeps its existing header visibility and expanded New and Settings controls', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop characterization');
  await expect(page.locator('#mobile-tab-bar')).toBeHidden();
  // The gear's parent header is already hidden on desktop; do not redesign it
  // merely to manufacture a visible #gear-btn assertion.
  await expect(page.locator('body > header')).toBeHidden();
  expect(await page.locator('#gear-btn').evaluate(el => getComputedStyle(el).display)).not.toBe('none');
  await expect(page.locator('.new-session-primary')).toBeVisible();
  await page.locator('#expanded-settings-btn').click();
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await page.locator('#settings-back-btn').click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
});
