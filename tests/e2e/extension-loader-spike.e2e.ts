import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-spike' blob:; connect-src 'self'; object-src 'none" }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`http://127.0.0.1:${port}`); await expect(page.locator("output")).toHaveText("loaded"); expect(authorized).toBe(1);
    await page.evaluate(() => sessionStorage.clear()); await page.goto(`http://127.0.0.1:${port}?mode=missing`); await expect(page.locator("output")).toHaveText("FETCH_FAILED");
    const beforeSafe = requests; await page.goto(`http://127.0.0.1:${port}?mode=safe`); await expect(page.locator("output")).toHaveText("SAFE_MODE"); expect(requests).toBe(beforeSafe);
    await page.goto(`http://127.0.0.1:${port}?mode=digest`); await expect(page.locator("output")).toHaveText("INTEGRITY_MISMATCH"); expect(page.url()).not.toContain("spike-token");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(output, { recursive: true, force: true }); }
});
