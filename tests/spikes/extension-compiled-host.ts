import { join } from "node:path";
import { EXTENSION_BUNDLE_MAX_BYTES } from "../../public/extension-loader.ts";
import { readBoundedRegularFile } from "../../src/extensions/bounded-file.ts";

/** Isolated feasibility host only. This is not Wolfpack's production auth/router. */
export function startCompiledExtensionFixture(loaderSource: string, packageRoot: string): void {
  let requests = 0;
  let authorized = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const noStore = { "Cache-Control": "no-store" };
      if (url.pathname === "/loader.js") return new Response(loaderSource, { headers: { ...noStore, "Content-Type": "text/javascript" } });
      if (url.pathname === "/metrics") return Response.json({ requests, authorized, cwd: process.cwd() }, { headers: noStore });
      if (url.pathname === "/api/extensions/example/bundle.js") {
        requests++;
        if (request.headers.get("authorization") !== "Bearer compiled-fixture-token") return new Response("denied", { status: 401, headers: noStore });
        authorized++;
        return new Response(readBoundedRegularFile(join(packageRoot, "bundle.js"), EXTENSION_BUNDLE_MAX_BYTES), {
          headers: { ...noStore, "Content-Type": "text/javascript" },
        });
      }
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      const inventory: unknown = JSON.parse(readBoundedRegularFile(join(packageRoot, "inventory.json"), 1024).toString("utf8"));
      const digest = (inventory as { sha256: string }).sha256;
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid fixture inventory");
      const mode = url.searchParams.get("mode");
      const token = mode === "missing" ? "sessionStorage.clear();" : "sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify({[location.origin]:'compiled-fixture-token'}));";
      const expected = mode === "digest" ? "0".repeat(64) : digest;
      const html = `<body><output>pending</output><script type="module" nonce="fixture">
        import { loadAuthenticatedExtensionBundle } from '/loader.js';
        ${token}
        try {
          const value = await loadAuthenticatedExtensionBundle('/api/extensions/example/bundle.js', '${expected}', {safeMode:${mode === "safe"}});
          document.querySelector('output').textContent = value.result;
        } catch (error) { document.querySelector('output').textContent = error.code; }
      </script></body>`;
      return new Response(html, { headers: {
        ...noStore,
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-fixture' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } });
    },
  });
  process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
  const stop = () => { server.stop(true); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
