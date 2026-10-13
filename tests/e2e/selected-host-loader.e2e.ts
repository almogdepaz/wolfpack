import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createOwnedTestServerHome, removeOwnedTestServerHome } from "./test-server-home.ts";

const ROOT = join(import.meta.dirname, "..", "..");
function fixtureBearer(secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000), payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
interface Measurement { readonly peers: Record<"a" | "b", { readonly paths: readonly string[]; readonly rpcCounts: { readonly publicHandshake: number; readonly catalogPolicy: number; readonly assets: number; readonly documents: number; readonly git: number }; readonly inferredAssetPayloadBytes: number }> }

test('installed runtimes and production proxy preserve native provenance through real verified Blob imports and warm same-UUID scope switching', async ({ page }) => {
  const home = createOwnedTestServerHome(), entry = join(home.path, 'entry.ts'), bundle = join(home.path, 'extension-gate.js');
  writeFileSync(entry, ['ExtensionHost:extension-host', 'SelectedHostExtensionTransport:extension-transport', 'loadAuthenticatedExtensionBundle:extension-loader', 'EXTENSION_BUNDLE_MAX_BYTES:extension-loader'].map(pair => { const [symbol, file] = pair.split(':'); return `export { ${symbol} } from ${JSON.stringify(join(ROOT, 'public', file + '.ts'))};`; }).join('\n'));
  execFileSync('bun', ['build', entry, '--outfile', bundle, '--target=browser', '--format=esm'], { cwd: ROOT, stdio: 'pipe' });
  const child = spawn('bun', [join(ROOT, 'tests/e2e/selected-host-loader-server.ts')], { cwd: ROOT, env: { ...process.env, HOME: home.path, TMPDIR: home.path, XDG_CONFIG_HOME: join(home.path, 'config'), XDG_DATA_HOME: join(home.path, 'data'), WOLFPACK_TEST: '1', WOLFPACK_TEST_EXTENSION_GATE_BUNDLE: bundle, WOLFPACK_SETTINGS_PATH: join(home.path, 'settings.json'), WOLFPACK_MACHINE_ID_PATH: join(home.path, 'machine-id'), WOLFPACK_TASK_ROOT: join(home.path, 'tasks'), WOLFPACK_TASK_RELAY_ROOT: join(home.path, 'relay') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [], stdout: Buffer[] = []; child.stderr!.on('data', data => stderr.push(Buffer.from(data))); child.stdout!.on('data', data => stdout.push(Buffer.from(data)));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      guard = setTimeout(() => reject(new Error('owned loader server readiness deadline')), 10_000);
      child.stdout!.on('data', () => { const match = Buffer.concat(stdout).toString().match(/^READY:(\d+)$/m); if (match) resolve(`http://127.0.0.1:${match[1]}`); });
      child.once('exit', code => reject(new Error(`owned loader server exited ${code}`)));
    }); clearTimeout(guard);
    const local = fixtureBearer('selected-host-local-test-secret-123');
    await page.addInitScript(values => sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify(values)), { [base]: local, 'https://a.fixture.ts.net': fixtureBearer('selected-host-peer-a-secret-123'), 'https://b.fixture.ts.net': fixtureBearer('selected-host-peer-b-secret-123') });
    const measure = async (): Promise<Measurement> => {
      const response = await fetch(`${base}/api/extensions/fixture/measurements`, { headers: { Authorization: `Bearer ${local}` } }); expect(response.status).toBe(200); return await response.json() as Measurement;
    };
    const snapshots: Array<{ target: string; counts: Measurement }> = [];
    await page.goto(base); await expect(page.locator('#ready')).toHaveText('local');
    await page.getByRole('button', { name: 'Select A', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
    const pending = await measure(); expect(pending.peers.a.rpcCounts.assets).toBe(0);
    expect(pending.peers.a.rpcCounts.publicHandshake).toBe(2); expect(pending.peers.a.rpcCounts.catalogPolicy).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { remoteBundleEvaluations?: number }).remoteBundleEvaluations ?? 0)).toBe(0);
    await page.getByRole('button', { name: 'Trust this inventory', exact: true }).click();
    await expect(page.locator('[data-peer-code="a"]')).toHaveText('code a'); await expect(page.locator('[data-peer-document="a"]')).toHaveText('document a'); await expect(page.locator('[data-peer-git="a"]')).toHaveText('branch-a:only-a.txt');
    await page.getByRole('textbox', { name: 'Selected widget draft' }).fill('draft a'); snapshots.push({ target: 'a-cold', counts: await measure() });
    await page.getByRole('button', { name: 'Select B', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
    expect((await measure()).peers.b.rpcCounts.assets).toBe(0); await page.getByRole('button', { name: 'Trust this inventory', exact: true }).click();
    await expect(page.locator('[data-peer-document="b"]')).toHaveText('document b'); await expect(page.locator('[data-peer-git="b"]')).toHaveText('branch-b:only-b.txt');
    await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue(''); snapshots.push({ target: 'b-cold', counts: await measure() });
    await page.getByRole('button', { name: 'Select A', exact: true }).click(); await expect(page.locator('[data-peer-document="a"]')).toHaveText('document a'); await expect(page.locator('[data-peer-git="a"]')).toHaveText('branch-a:only-a.txt');
    await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('draft a'); snapshots.push({ target: 'a-warm', counts: await measure() });
    expect(snapshots[2]!.counts.peers.a.rpcCounts.assets).toBe(1); expect(snapshots[2]!.counts.peers.b.rpcCounts.assets).toBe(1);
    expect(snapshots[2]!.counts.peers.a.inferredAssetPayloadBytes).toBe(snapshots[0]!.counts.peers.a.inferredAssetPayloadBytes);
    expect(snapshots[2]!.counts.peers.a.rpcCounts.catalogPolicy).toBeGreaterThan(snapshots[0]!.counts.peers.a.rpcCounts.catalogPolicy);
    const browser = await page.evaluate(() => { const state = window as unknown as { nativeProvenance: Array<{ input: string; url: string; redirected: boolean; observedAssetPayloadBytes?: number; originalBodyUnused: boolean }>; loaderTargets: string[]; remoteBundleEvaluations: number; switchMeasurements: unknown }; return { provenance: state.nativeProvenance, loaderTargets: state.loaderTargets, evaluations: state.remoteBundleEvaluations, measurements: state.switchMeasurements }; });
    expect(browser.evaluations).toBe(2); expect(browser.loaderTargets).toHaveLength(2);
    const assets = browser.provenance.filter(value => value.input.startsWith('/api/extensions/assets/'));
    expect(assets).toHaveLength(2); expect(assets.map(value => value.url)).toEqual(browser.loaderTargets.map(target => new URL(target, base).href));
    expect(assets.every(value => value.url.startsWith(base + '/api/extensions/peer/') && !value.redirected && value.originalBodyUnused)).toBe(true);
    expect(assets.map(value => value.observedAssetPayloadBytes)).toEqual([944, 944]);
    const observedAssetPayloads = assets.map(value => ({ url: value.url, bytes: value.observedAssetPayloadBytes }));
    await page.getByRole('button', { name: 'Select local', exact: true }).click(); await expect(page.locator('#ready')).toHaveText('local'); await expect(page.locator('[data-peer-code]')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Ordinary input' }).fill('still usable'); await expect(page.getByRole('textbox', { name: 'Ordinary input' })).toHaveValue('still usable');
    const receipt = test.info().outputPath('production-proxy-loader-counts.json');
    writeFileSync(receipt, JSON.stringify({ boundary: 'actual installed runtimes, HTTP middleware/proxy, docs/git, native browser Responses and digest Blob imports; controlled exact session facts and ready registry plus mapped Tailnet DNS/TLS; NOT native broker/grid or Tailnet latency', bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), snapshots, observedAssetPayloads, payloadMeasurement: 'successful bounded native response clone bodies, originals returned unchanged; NOT HTTP/TLS wire bytes', browser }, null, 2));
    await test.info().attach('production-proxy-loader-counts', { path: receipt, contentType: 'application/json' });
  } finally {
    clearTimeout(guard); if (child.exitCode === null) child.stdin!.end();
    const ended = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { guard = setTimeout(() => resolve(false), 3000); })]); clearTimeout(guard);
    if (!ended) { child.kill('SIGKILL'); await exited; }
    writeFileSync(test.info().outputPath('owned-server.stderr.log'), Buffer.concat(stderr)); writeFileSync(test.info().outputPath('owned-server.stdout.log'), Buffer.concat(stdout));
    removeOwnedTestServerHome(home);
  }
});
