import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ASSET_VERSIONS } from "../../src/public-assets";
import { serveFile } from "../../src/server/http";

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    serveFile(response, filename, request);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

describe("static asset delivery", () => {
  test("negotiates Brotli for compressible bundles", async () => {
    const response = await fetch(`${baseUrl}/app.bundle.js`, {
      headers: { "Accept-Encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(await response.text()).toContain("showView");
  });

  test("revalidates unversioned assets with a stable ETag", async () => {
    const first = await fetch(`${baseUrl}/styles.css`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const second = await fetch(`${baseUrl}/styles.css`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });

  test("serves generated version URLs as immutable", async () => {
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    const appVersion = ASSET_VERSIONS["app.bundle.js"];
    const ghosttyVersion = ASSET_VERSIONS["ghostty-web.bundle.js"];
    expect(appVersion).toMatch(/^[a-f0-9]{16}$/);
    expect(ghosttyVersion).toMatch(/^[a-f0-9]{16}$/);
    expect(html).toContain(`/app.bundle.js?v=${appVersion}`);
    expect(html).toContain(`/ghostty-web.bundle.js?v=${ghosttyVersion}`);
    expect(html).not.toContain("__WOLFPACK_ASSET_VERSION__");

    const asset = await fetch(`${baseUrl}/app.bundle.js?v=${appVersion}`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
