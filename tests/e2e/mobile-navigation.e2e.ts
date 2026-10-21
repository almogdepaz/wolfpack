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

for (const width of [320, 375, 390]) test(`Sessions header New reuses delegated project and agent flow and restores focus at ${width}`, async ({ page }, info) => {
  if (info.project.name !== 'desktop') await page.setViewportSize({ width, height: 844 });
  const trigger = page.locator('.new-session-primary');
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
