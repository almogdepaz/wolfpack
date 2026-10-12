import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const TEST_HTML = '<!doctype html><html><head><script src="/a.js"></script><script src="/b.js"></script></head><body></body></html>';

const { serveFile, serveHtml } = await import("../../src/server/http.js");

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/index.html") {
      serveFile(res, "index.html", req);
    } else {
      serveHtml(res, TEST_HTML);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe("CSP header on HTML responses", () => {
  test("contains nonce in script-src, not unsafe-inline", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();

    const scriptSrc = csp!.split(";").find(d => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).toContain("blob:");
  });

  test("serveFile applies CSP and nonces to the charset-bearing index asset", async () => {
    const res = await fetch(base + "/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const scriptSrc = csp!.split(";").find(d => d.trim().startsWith("script-src"));
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).toContain("blob:");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    const nonce = csp!.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  test("connect-src permits the Ghostty embedded WASM loader", async () => {
    const res = await fetch(base + "/index.html");
    const csp = res.headers.get("content-security-policy")!;
    const connectSrc = csp.split(";").find(d => d.trim().startsWith("connect-src"));
    // Ghostty's loader fetches its embedded WASM from a data: URL.
    expect(connectSrc).toContain("data:");
  });

  for (const encoding of ["br", "gzip"]) {
    test(`compresses nonce-bearing HTML with ${encoding} without caching a nonce`, async () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const res = await fetch(base + "/index.html", {
          headers: { "Accept-Encoding": encoding },
        });
        expect(res.headers.get("content-encoding")).toBe(encoding);
        expect(res.headers.get("vary")).toContain("Accept-Encoding");
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-cache");
        expect(res.headers.get("etag")).toBeNull();
        const csp = res.headers.get("content-security-policy")!;
        const nonce = csp.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
        expect(nonce).toBeTruthy();
        nonces.add(nonce!);
        const html = await res.text();
        const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
        expect(scriptTags.length).toBeGreaterThan(0);
        for (const tag of scriptTags) {
          expect(tag).toContain(`nonce="${nonce}"`);
        }
      }
      expect(nonces.size).toBe(2);
    });
  }

  test("does not compress HTML with disabled encodings", async () => {
    const res = await fetch(base + "/index.html", {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=0" },
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toContain("<script nonce=");
  });

  test("nonce in CSP matches nonce in HTML script tags", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy")!;
    const html = await res.text();

    const cspNonce = csp.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
    expect(cspNonce).toBeTruthy();

    const scriptTags = html.match(/<script [^>]*>/g) || [];
    expect(scriptTags.length).toBe(2);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${cspNonce}"`);
    }
  });

  test("each request gets a unique nonce", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(base + "/");
      const csp = res.headers.get("content-security-policy")!;
      const nonce = csp.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
      expect(nonce).toBeTruthy();
      nonces.add(nonce!);
    }
    expect(nonces.size).toBe(5);
  });

  test("style-src still allows unsafe-inline", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy")!;
    const styleSrc = csp.split(";").find(d => d.trim().startsWith("style-src"));
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  test("script-src includes self", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy")!;
    const scriptSrc = csp.split(";").find(d => d.trim().startsWith("script-src"));
    expect(scriptSrc).toContain("'self'");
  });

  test("non-HTML assets do not get CSP header", async () => {
    // Create a server that serves JS
    const jsServer = createServer((_req, res) => { serveFile(res, "app.bundle.js"); });
    await new Promise<void>((resolve) => jsServer.listen(0, "127.0.0.1", resolve));
    const jsBase = `http://127.0.0.1:${(jsServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(jsBase + "/a.js");
      const csp = res.headers.get("content-security-policy");
      expect(csp).toBeNull();
    } finally {
      jsServer.close();
    }
  });
});
