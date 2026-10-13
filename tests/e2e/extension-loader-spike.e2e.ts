import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("selected-host trust dialog aborts on scope loss without stealing new terminal focus", async ({ page }) => {
  const output = mkdtempSync(join(tmpdir(), "wolfpack-extension-dialog-spike-"));
  execFileSync("bun", ["build", join(sourceRoot, "public", "app-dialog.ts"), "--outfile", join(output, "dialog.js"), "--target=browser", "--format=esm"], { stdio: "pipe" });
  const script = readFileSync(join(output, "dialog.js"));
  const server = createServer((request, response) => {
    if (request.url === "/dialog.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); return; }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<body><input id="terminal" aria-label="Terminal input"><button id="open">Trust peer</button><output>pending</output>
      <dialog id="app-dialog"><form id="app-dialog-form"><h2 id="app-dialog-title"></h2><p id="app-dialog-message"></p><div id="app-dialog-fields"></div><button id="app-dialog-cancel" type="button"></button><button id="app-dialog-confirm" type="submit"></button></form></dialog>
      <script type="module">import { showAppDialog } from '/dialog.js'; window.scopeAbort = new AbortController(); document.querySelector('#open').onclick = async () => { const value = await showAppDialog({ title: 'Trust verified peer?', confirmLabel: 'Trust', signal: window.scopeAbort.signal }); document.querySelector('output').textContent = value === null ? 'cancelled' : 'trusted'; };</script></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Trust peer", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { scopeAbort: AbortController }).scopeAbort.abort();
      document.querySelector<HTMLInputElement>('#terminal')!.focus();
    });
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator("output")).toHaveText("cancelled");
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
    await page.getByRole("textbox", { name: "Terminal input" }).fill("still usable");
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toHaveValue("still usable");
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
    await page.evaluate(async () => {
      const moduleUrl = '/dialog.js';
      const { showAppDialog } = await import(moduleUrl) as typeof import('../../public/app-dialog.ts');
      const oldScope = new AbortController();
      const first = showAppDialog({ title: 'Old scope', confirmLabel: 'Old trust', signal: oldScope.signal });
      oldScope.abort();
      document.querySelector('output')!.textContent = 'second pending';
      (window as unknown as { secondSettled: boolean }).secondSettled = false;
      const second = showAppDialog({ title: 'New scope', confirmLabel: 'New trust' });
      void second.then((value: unknown) => {
        (window as unknown as { secondSettled: boolean }).secondSettled = true;
        document.querySelector('output')!.textContent = value === null ? 'second cancelled' : 'second confirmed';
      });
      await first;
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#app-dialog-title")).toHaveText("New scope");
    expect(await page.evaluate(() => (window as unknown as { secondSettled: boolean }).secondSettled)).toBe(false);
    await page.getByRole("button", { name: "New trust", exact: true }).click();
    await expect(page.locator("output")).toHaveText("second confirmed");
    await page.evaluate(async () => {
      const moduleUrl = '/dialog.js';
      const { showAppDialog } = await import(moduleUrl) as typeof import('../../public/app-dialog.ts');
      const closingScope = new AbortController(), cancelledScope = new AbortController();
      const first = showAppDialog({ title: 'Closing scope', confirmLabel: 'Closing trust', signal: closingScope.signal });
      closingScope.abort();
      const queued = showAppDialog({ title: 'MUST NOT open', confirmLabel: 'Stale trust', signal: cancelledScope.signal });
      cancelledScope.abort();
      document.querySelector<HTMLInputElement>('#terminal')!.focus();
      const values = await Promise.all([first, queued]);
      document.querySelector('output')!.textContent = values.every(value => value === null) ? 'queued cancelled' : 'unexpected consent';
    });
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator("#app-dialog-title")).toHaveText("Closing scope");
    await expect(page.locator("output")).toHaveText("queued cancelled");
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(output, { recursive: true, force: true }); }
});

test("selected-host browser transport separates credentials and retries only typed peer authentication once", async ({ page }) => {
  const output = mkdtempSync(join(tmpdir(), "wolfpack-extension-transport-spike-"));
  execFileSync("bun", ["build", join(sourceRoot, "public", "extension-transport.ts"), "--outfile", join(output, "transport.js"), "--target=browser", "--format=esm"], { stdio: "pipe" });
  const script = readFileSync(join(output, "transport.js"));
  const requests: Array<{ url: string; local: string | undefined; peer: string | string[] | undefined }> = [];
  let mode = "peer";
  const server = createServer((request, response) => {
    if (request.url === "/transport.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); return; }
    if (request.url?.startsWith("/api/extensions/peer/")) {
      requests.push({ url: request.url, local: request.headers.authorization, peer: request.headers["x-wolfpack-extension-peer-authorization"] });
      const authorized = mode === "peer" && request.headers["x-wolfpack-extension-peer-authorization"] === "Bearer remote-token";
      response.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(authorized ? { safeMode: false, installations: [] } : { error: mode === "local" ? "authentication required" : { code: "PEER_AUTH_REQUIRED", message: "Selected peer requires authentication" } })); return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<body><button id="read">Read selected peer</button><output>pending</output>
      <dialog id="app-dialog"><form id="app-dialog-form"><h2 id="app-dialog-title"></h2><p id="app-dialog-message"></p><div id="app-dialog-fields"></div><button id="app-dialog-cancel" type="button"></button><button id="app-dialog-confirm" type="submit"></button></form></dialog>
      <script type="module">import { SelectedHostExtensionTransport } from '/transport.js'; sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify({[location.origin]:'local-token'})); window.scopeAbort = new AbortController();
      const machine = 'node-a:11111111-1111-4111-8111-111111111111'; const transport = new SelectedHostExtensionTransport({resolvePeer: () => ({ identity: machine, status: 'ready', origin: 'https://peer.example.ts.net', displayName: 'Verified peer' })});
      document.querySelector('#read').onclick = async () => { try { const response = await transport.request({ sessionId: '22222222-2222-4222-8222-222222222222', machine }, '/api/extensions', { signal: window.scopeAbort.signal }); window.lastResponseUrl = response.url; document.querySelector('output').textContent = String(response.status); } catch { document.querySelector('output').textContent = 'cancelled'; } };</script></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await page.goto(base); await page.getByRole("button", { name: "Read selected peer" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#app-dialog-message")).toContainText("Verified peer (https://peer.example.ts.net)");
    await page.getByRole("textbox", { name: "Access token" }).fill("remote-token");
    await page.getByRole("button", { name: "Authenticate", exact: true }).click();
    await expect(page.locator("output")).toHaveText("200"); expect(requests).toHaveLength(2);
    expect(await page.evaluate(() => (window as unknown as { lastResponseUrl: string }).lastResponseUrl)).toBe(`${base}/api/extensions/peer/${encodeURIComponent("node-a:11111111-1111-4111-8111-111111111111")}/catalog`);
    expect(requests.map(item => item.local)).toEqual(["Bearer local-token", "Bearer local-token"]);
    expect(requests.map(item => item.peer)).toEqual([undefined, "Bearer remote-token"]);
    expect(requests.every(item => !item.url.includes("token"))).toBe(true);
    mode = "wrong"; const beforeWrong = requests.length;
    await page.goto(base); await page.getByRole("button", { name: "Read selected peer" }).click();
    await page.getByRole("textbox", { name: "Access token" }).fill("wrong-token");
    await page.getByRole("button", { name: "Authenticate", exact: true }).click();
    await expect(page.locator("output")).toHaveText("401"); expect(requests.length - beforeWrong).toBe(2);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    mode = "local"; const beforeLocal = requests.length;
    await page.goto(base); await page.getByRole("button", { name: "Read selected peer" }).click();
    await expect(page.locator("output")).toHaveText("401"); expect(requests.length - beforeLocal).toBe(1);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    mode = "peer";
    await page.goto(base); await page.getByRole("button", { name: "Read selected peer" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => (window as unknown as { scopeAbort: AbortController }).scopeAbort.abort());
    await expect(page.getByRole("dialog")).not.toBeVisible(); await expect(page.locator("output")).toHaveText("cancelled");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(output, { recursive: true, force: true }); }
});

test("selected-host browser component isolates same-UUID remote bundles and reuses verified warm code", async ({ page }) => {
  const output = mkdtempSync(join(tmpdir(), "wolfpack-extension-host-spike-"));
  execFileSync("bun", ["build", join(sourceRoot, "public", "extension-host.ts"), "--outfile", join(output, "host.js"), "--target=browser", "--format=esm"], { stdio: "pipe" });
  const script = readFileSync(join(output, "host.js"));
  const ids = { a: "11111111-1111-4111-8111-111111111111", b: "33333333-3333-4333-8333-333333333333" };
  const assets = { a: 0, b: 0 }, catalogs = { a: 0, b: 0 }, bytes = { a: 0, b: 0 };
  const bundles = Object.fromEntries((["a", "b"] as const).map(key => [key, Buffer.from(`
    globalThis.bundleEvaluations = (globalThis.bundleEvaluations || 0) + 1;
    export default host => { host.registerContextView({ id: 'view', title: 'Notes', mount(root, context) {
      const label = document.createElement('output'); label.setAttribute('data-bundle', '${key}'); label.textContent = 'bundle ${key}';
      const note = document.createElement('p'); note.setAttribute('data-document', '${key}');
      const draft = document.createElement('textarea'); draft.setAttribute('aria-label', 'Widget draft'); draft.value = context.storage.get('draft') || '';
      draft.oninput = () => context.storage.set('draft', draft.value); root.append(label, note, draft);
      context.documents.subscribe('context', value => { note.textContent = value || ''; });
      return { dispose() { globalThis.viewDisposals = (globalThis.viewDisposals || 0) + 1; } };
    } }); };
  `)])) as Record<"a" | "b", Buffer>;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/host.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); return; }
    if (url.pathname.startsWith("/api/extensions")) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/extensions") { response.end(JSON.stringify({ safeMode: false, installations: [] })); return; }
      const parts = url.pathname.split("/"); const machine = decodeURIComponent(parts[4] ?? "");
      const key = machine.startsWith("node-a:") ? "a" : "b";
      const digest = createHash("sha256").update(bundles[key]).digest("hex");
      const packageDigest = (key === "a" ? "a" : "c").repeat(64);
      if (parts[5] === "catalog") {
        catalogs[key]++;
        response.end(JSON.stringify({ safeMode: false, installations: [{ installationId: ids[key], extensionId: "notes", enabled: true, package: { name: `remote-only-notes-${key}`, version: "1.0.0", digest: packageDigest }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${packageDigest}/dist/ui.js`, digest, mime: "text/javascript" }, documents: [{ id: "context", schemaVersion: 1 }] }] })); return;
      }
      if (parts[5] === "assets") { assets[key]++; bytes[key] += bundles[key].length; response.setHeader("Content-Type", "text/javascript"); response.setHeader("X-Wolfpack-Extension-Digest", digest); response.end(bundles[key]); return; }
      if (parts[5] === "documents") { response.end(JSON.stringify({ installationId: ids[key], scopeSessionId: url.searchParams.get("session"), extensionId: "notes", documentId: "context", revision: 1, document: `document ${key}` })); return; }
      response.writeHead(404); response.end("{}"); return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-host' blob:; connect-src 'self'; object-src 'none'" });
    response.end(`<body><input aria-label="Terminal input"><button id="a">Select A</button><button id="b">Select B</button><button id="local">Select local</button><output id="ready">local</output><div id="widgets"></div>
      <dialog id="app-dialog"><form id="app-dialog-form"><h2 id="app-dialog-title"></h2><p id="app-dialog-message"></p><div id="app-dialog-fields"></div><button id="app-dialog-cancel" type="button"></button><button id="app-dialog-confirm" type="submit"></button></form></dialog>
      <script type="module" nonce="host">import { ExtensionHost } from '/host.js'; const ids = ${JSON.stringify(ids)}; let scope = {sessionId:'22222222-2222-4222-8222-222222222222'}; window.switchMeasurements = [];
      const host = new ExtensionHost({container:document.querySelector('#widgets'), scope:() => scope, resolvePeer:machine => ({identity:machine, status:'ready', origin:'https://' + machine.split(':')[0] + '.example.ts.net', displayName:machine.split(':')[0]})});
      for (const key of ['a','b','local']) document.querySelector('#' + key).onclick = async () => { const start = performance.now(); scope = key === 'local' ? {sessionId:scope.sessionId} : {sessionId:scope.sessionId, machine:'node-' + key + ':' + ids[key]}; document.querySelector('#ready').textContent='loading'; await host.refresh(); host.select(); window.switchMeasurements.push({target:key, milliseconds:performance.now()-start}); document.querySelector('#ready').textContent=key; }; await host.refresh();</script></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Select A", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(assets).toEqual({ a: 0, b: 0 });
    expect(await page.evaluate(() => (window as unknown as { bundleEvaluations?: number }).bundleEvaluations ?? 0)).toBe(0);
    await page.getByRole("button", { name: "Trust this inventory", exact: true }).click();
    await expect(page.locator('[data-document="a"]')).toHaveText("document a");
    await page.getByRole("textbox", { name: "Widget draft" }).fill("draft a");
    await page.getByRole("button", { name: "Select B", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(assets).toEqual({ a: 1, b: 0 });
    expect(await page.evaluate(() => (window as unknown as { bundleEvaluations: number }).bundleEvaluations)).toBe(1);
    await page.getByRole("button", { name: "Trust this inventory", exact: true }).click();
    await expect(page.locator('[data-document="b"]')).toHaveText("document b");
    await expect(page.getByRole("textbox", { name: "Widget draft" })).toHaveValue("");
    await expect(page.locator('[data-bundle="a"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Select A", exact: true }).click();
    await expect(page.locator('[data-document="a"]')).toHaveText("document a");
    await expect(page.getByRole("textbox", { name: "Widget draft" })).toHaveValue("draft a");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(assets).toEqual({ a: 1, b: 1 }); expect(catalogs).toEqual({ a: 2, b: 1 });
    expect(await page.evaluate(() => (window as unknown as { bundleEvaluations: number }).bundleEvaluations)).toBe(2);
    await page.getByRole("button", { name: "Select local", exact: true }).click();
    await expect(page.locator("#ready")).toHaveText("local"); await expect(page.getByRole("textbox", { name: "Widget draft" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Terminal input" }).fill("still usable");
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toHaveValue("still usable");
    const receipt = test.info().outputPath("component-cold-warm-counts.json");
    writeFileSync(receipt, JSON.stringify({ boundary: "browser host plus gateway fixture, NOT installed-runtime proxy acceptance", assets, catalogs, bytes, measurements: await page.evaluate(() => (window as unknown as { switchMeasurements: unknown }).switchMeasurements) }, null, 2));
    await test.info().attach("component-cold-warm-counts", { path: receipt, contentType: "application/json" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(output, { recursive: true, force: true }); }
});

test("authenticated bounded Blob loader rejects unsafe paths before import", async ({ page }) => {
  const output = mkdtempSync(join(tmpdir(), "wolfpack-extension-loader-spike-"));
  execFileSync("bun", ["build", join(sourceRoot, "public", "extension-loader.ts"), "--outfile", join(output, "extension-loader.js"), "--target=browser", "--format=esm"], { stdio: "pipe" });
  const loader = readFileSync(join(output, "extension-loader.js")); const bundle = Buffer.from("export const authenticatedModule = 'loaded';"); const digest = createHash("sha256").update(bundle).digest("hex");
  let authorized = 0; let requests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/extension-loader.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(loader); return; }
    if (url.pathname === "/api/extensions/bundle") { requests++; if (request.headers.authorization !== "Bearer spike-token") { response.writeHead(401, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); response.end("denied"); return; } authorized++; response.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": String(bundle.length), "Cache-Control": "no-store" }); response.end(bundle); return; }
    const mode = url.searchParams.get("mode") ?? "ok";
    const token = mode === "missing" ? "" : "sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify({ [location.origin]: 'spike-token' }));";
    const safe = mode === "safe" ? "true" : "false"; const expected = mode === "digest" ? "'0'.repeat(64)" : `'${digest}'`;
    const html = `<body><output>pending</output><script type="module" nonce="spike">import { loadAuthenticatedExtensionBundle } from '/extension-loader.js'; ${token} try { const loaded = await loadAuthenticatedExtensionBundle('/api/extensions/bundle', ${expected}, {safeMode:${safe}, timeoutMs:500, maxBytes:1024}); document.querySelector('output').textContent = loaded.authenticatedModule; } catch (error) { document.querySelector('output').textContent = error.code; }</script></body>`;
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-spike' blob:; connect-src 'self'; object-src 'none'" }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`http://127.0.0.1:${port}`); await expect(page.locator("output")).toHaveText("loaded"); expect(authorized).toBe(1);
    await page.evaluate(() => sessionStorage.clear()); await page.goto(`http://127.0.0.1:${port}?mode=missing`); await expect(page.locator("output")).toHaveText("FETCH_FAILED");
    const beforeSafe = requests; await page.goto(`http://127.0.0.1:${port}?mode=safe`); await expect(page.locator("output")).toHaveText("SAFE_MODE"); expect(requests).toBe(beforeSafe);
    await page.goto(`http://127.0.0.1:${port}?mode=digest`); await expect(page.locator("output")).toHaveText("INTEGRITY_MISMATCH"); expect(page.url()).not.toContain("spike-token");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(output, { recursive: true, force: true }); }
});
