import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..");
test.use({ hasTouch: true });
test('passive extension authentication preserves input, masks secrets, clears stale actions and leaves ordinary dialog ownership independent', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'wolfpack-extension-access-')), entry = join(root, 'entry.ts'), bundle = join(root, 'prompt.js');
  writeFileSync(entry, `export { createExtensionAccessPrompt } from ${JSON.stringify(join(ROOT, 'public/extension-access-prompt.ts'))}; export { showAppDialog } from ${JSON.stringify(join(ROOT, 'public/app-dialog.ts'))};`);
  execFileSync('bun', ['build', entry, '--outfile', bundle, '--target=browser', '--format=esm'], { cwd: ROOT, stdio: 'pipe' });
  const script = readFileSync(bundle);
  const server = createServer((req, res) => {
    if (req.url === '/prompt.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(script); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<input aria-label="Ordinary input"><section id="access" hidden></section><output id="result">idle</output>
<dialog id="app-dialog"><form id="app-dialog-form"><h2 id="app-dialog-title"></h2><p id="app-dialog-message"></p><div id="app-dialog-fields"></div><button id="app-dialog-cancel" type="button"></button><button id="app-dialog-confirm" type="submit"></button></form></dialog>
<script type="module">import { createExtensionAccessPrompt, showAppDialog } from '/prompt.js';
const prompt=createExtensionAccessPrompt(document.querySelector('#access'),()=>{});
window.startAccess=()=>{window.scope=new AbortController();document.querySelector('#result').textContent='pending';return prompt({title:'Selected machine authentication',message:'Verified peer (https://a.fixture.ts.net)',fields:[{name:'token',label:'Access token'}],confirmLabel:'Authenticate',signal:window.scope.signal}).then(result=>{document.querySelector('#result').textContent=result===null?'cancelled':'confirmed'})};
window.openOrdinary=()=>showAppDialog({title:'Ordinary user dialog',confirmLabel:'Confirm ordinary'}).then(()=>{window.ordinaryDone=true});</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const ordinary = page.getByRole('textbox', { name: 'Ordinary input' }); await ordinary.fill('before prompt');
    await page.evaluate(() => { void (window as unknown as { startAccess(): Promise<void> }).startAccess(); });
    await expect(ordinary).toBeFocused(); await ordinary.fill('usable while authentication pending'); await expect(ordinary).toHaveValue('usable while authentication pending');
    await expect(page.getByLabel('Access token', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByLabel('Access token', { exact: true }).fill('temporary-fixture-token');
    const oldField = await page.getByLabel('Access token', { exact: true }).elementHandle(), oldButton = await page.getByRole('button', { name: 'Authenticate', exact: true }).elementHandle();
    if (!oldField || !oldButton) throw new Error('owned prompt controls missing');
    await ordinary.focus(); await page.evaluate(() => (window as unknown as { scope: AbortController }).scope.abort());
    await expect(page.locator('#result')).toHaveText('cancelled'); await expect(page.locator('#access')).toBeHidden(); await expect(ordinary).toBeFocused();
    expect(await oldField.evaluate(input => (input as HTMLInputElement).value)).toBe('');
    await oldButton.evaluate(button => (button as HTMLButtonElement).click()); await expect(page.locator('#result')).toHaveText('cancelled');
    await page.evaluate(() => { void (window as unknown as { startAccess(): Promise<void> }).startAccess(); });
    await page.evaluate(() => { void (window as unknown as { openOrdinary(): Promise<unknown> }).openOrdinary(); });
    await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: 'Confirm ordinary', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { ordinaryDone?: boolean }).ordinaryDone)).toBe(true);
    await expect(page.locator('#result')).toHaveText('pending');
    await page.getByLabel('Access token', { exact: true }).fill('deliberate-fixture-token'); await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Authenticate', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.locator('#result')).toHaveText('confirmed'); await expect(page.locator('#access')).toBeHidden();
    await page.evaluate(() => { void (window as unknown as { startAccess(): Promise<void> }).startAccess(); });
    await page.getByRole('button', { name: 'Not now', exact: true }).tap();
    await expect(page.locator('#result')).toHaveText('cancelled'); await expect(page.locator('#access')).toBeHidden();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
