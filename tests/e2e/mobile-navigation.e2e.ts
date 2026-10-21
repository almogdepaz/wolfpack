import { writeFile } from 'node:fs/promises';
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

test('global New reuses the existing delegated project and agent picker flow', async ({ page }, info) => {
  // Before the redesign this is the mobile header +; afterward it is the New
  // action. Both must enter the same existing flow, not a parallel dialog.
  const trigger = page.locator('#mobile-new, .new-session-primary').filter({ visible: true }).first();
  await expect(trigger).toHaveAttribute('data-action', 'new-session');
  if (info.project.name === 'iphone-14') {
    await page.screenshot({ path: info.outputPath('navigation-390.png'), animations: 'disabled' });
  }
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
  }
});

for (const width of [375, 390, 412]) test(`mobile navigation has two destinations and a New action at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile navigation only');
  await page.setViewportSize({ width, height: 844 });
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const sessions = nav.getByRole('button', { name: 'Sessions', exact: true });
  const settings = nav.getByRole('link', { name: 'Settings', exact: true });
  const add = nav.getByRole('button', { name: 'New session', exact: true });
  await expect(nav).toBeVisible();
  expect(await nav.locator(':scope > *').allTextContents()).toEqual(['Sessions', 'New', 'Settings']);
  await expect(nav.locator(':scope > :not([data-action])')).toHaveCount(2);
  await expect(nav.locator('[data-action="new-session"]')).toHaveCount(1);
  await expect(page.locator('#mobile-machines')).toHaveCount(0);
  await expect(page.locator('#gear-btn')).toBeHidden();
  await expect(page.locator('.new-session-primary')).toBeHidden();
  const bounds = await nav.locator(':scope > *').evaluateAll(els => els.map(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  }));
  for (const box of bounds) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await expect(add.locator('svg')).toHaveCSS('width', '24px');
  await expect(add.locator('svg')).toHaveCSS('height', '24px');
  await expect(add).toHaveCSS('color', 'rgb(69, 237, 126)');
  await expect(sessions).toHaveCSS('color', 'rgb(69, 237, 126)');
  await writeFile(info.outputPath(`bounds-${width}.json`), JSON.stringify(bounds, null, 2));
  if (width === 390) await page.screenshot({ path: info.outputPath('navigation-390.png'), animations: 'disabled' });
  await add.focus();
  await add.press('Enter');
  await expect(page.locator('#new-project-name')).toBeFocused();
  await page.locator('#back-btn').click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
  await expect(add).toBeFocused();
  await settings.focus();
  await settings.press('Enter');
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await expect(settings).toHaveCSS('color', 'rgb(69, 237, 126)');
  await expect(sessions).toHaveCSS('color', 'rgb(127, 144, 135)');
  await expect(page.locator('#back-btn')).toBeFocused();
  await page.getByRole('link', { name: 'Machines', exact: true }).click();
  await expect(page.locator('#settings-machines')).toBeInViewport();
  await expect(page).toHaveURL(/#settings-machines$/);
  await add.focus();
  await add.press('Enter');
  await expect(page.locator('#projects-view')).toHaveClass(/visible/);
  await page.locator('#back-btn').click();
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await expect(add).toBeFocused();
  await expect(settings).toHaveCSS('color', 'rgb(69, 237, 126)');
  await page.locator('#back-btn').click();
  await expect(settings).toBeFocused();
  await sessions.click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
});

test('repeated mobile New preserves the original picker cancel destination', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'persistent mobile New action');
  const add = page.getByRole('button', { name: 'New session', exact: true });
  await add.click();
  await expect(page.locator('#projects-view')).toHaveClass(/visible/);
  await add.click();
  await expect(page.locator('#projects-view')).toHaveClass(/visible/);
  await page.locator('#back-btn').click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
  await expect(add).toBeFocused();
  await add.click();
  await page.getByRole('button', { name: 'Open project nav-project', exact: true }).click();
  await expect(page.locator('#agent-view')).toHaveClass(/visible/);
  await add.click();
  await expect(page.locator('#projects-view')).toHaveClass(/visible/);
  await page.locator('#back-btn').click();
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
  await expect(add).toBeFocused();
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
