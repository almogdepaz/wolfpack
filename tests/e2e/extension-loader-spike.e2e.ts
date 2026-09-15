import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("authenticated Blob module loader works under reviewed CSP", async ({ page }) => {
  const output = mkdtempSync(join(tmpdir(), "wolfpack-extension-loader-spike-"));
  execFileSync("bun", ["build", join(sourceRoot, "public", "extension-loader.ts"), "--outfile", join(output, "extension-loader.js"), "--target=browser", "--format=esm"], { stdio: "pipe" });
  const loader = readFileSync(join(output, "extension-loader.js"));
  const bundle = Buffer.from("export const authenticatedModule = 'loaded'; export default authenticatedModule;");
  const digest = createHash("sha256").update(bundle).digest("hex");
  let authorization = "";
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/extension-loader.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(loader); return; }
    if (path === "/bundle") { authorization = request.headers.authorization ?? ""; response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); response.end(bundle); return; }
    const html = `<body><output>pending</output><script type="module" nonce="spike">import { loadAuthenticatedExtensionBundle } from '/extension-loader.js'; sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify({ [location.origin]: 'spike-token' })); try { const loaded = await loadAuthenticatedExtensionBundle('/bundle', '${digest}'); document.querySelector('output').textContent = loaded.authenticatedModule; } catch (error) { document.querySelector('output').textContent = error.message; }</script></body>`;
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-spike' blob:; connect-src 'self'; object-src 'none'" }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("output")).toHaveText("loaded");
    expect(authorization).toBe("Bearer spike-token");
    expect(page.url()).not.toContain("spike-token");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); rmSync(output, { recursive: true, force: true }); }
});
