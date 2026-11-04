import { describe, expect, test } from "bun:test";
import { ASSET_VERSIONS, assets } from "../../src/public-assets";
import { gzipSync } from "node:zlib";
import { BUNDLE_BUDGETS } from "../../scripts/check-bundle-budgets";

describe("actual embedded browser asset budgets", () => {
  for (const [path, raw, gzip] of BUNDLE_BUDGETS) {
    const file = path.replace(/^public\//, "");
    test(`${file} shipped bytes meet existing raw/gzip caps`, () => {
      const content = assets.get(file)?.content;
      if (content === undefined) throw new Error(`missing shipped asset ${file}`);
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      expect(bytes.byteLength).toBeLessThanOrEqual(raw);
      expect(gzipSync(bytes, { level: 9 }).byteLength).toBeLessThanOrEqual(gzip);
    });
  }
  test("the served stylesheet is the only shipped CSS payload", () => {
    expect([...assets.keys()].filter(file => file.endsWith(".css"))).toEqual(["styles.css"]);
  });
});

describe("per-asset browser cache versions", () => {
  test("index URLs use the corresponding content hash", () => {
    const html = assets.get("index.html")?.content;
    expect(typeof html).toBe("string");
    for (const file of ["styles.css", "ghostty-web.bundle.js", "app.bundle.js"]) {
      expect(html as string).toContain(`/${file}?v=${ASSET_VERSIONS[file]}`);
    }
    expect(new Set(Object.values(ASSET_VERSIONS)).size).toBeGreaterThan(2);
  });

  test("service worker precaches the versioned shell URLs emitted by index", () => {
    const serviceWorker = assets.get("sw.js")?.content;
    expect(typeof serviceWorker).toBe("string");
    for (const file of ["styles.css", "app.bundle.js"]) {
      expect(serviceWorker as string).toContain(`"/${file}?v=${ASSET_VERSIONS[file]}"`);
    }
  });

  test("does not ship a standalone browser logic bundle", () => {
    const html = assets.get("index.html")?.content;
    const serviceWorker = assets.get("sw.js")?.content;

    expect(assets.has("wolfpack-lib.js")).toBeFalse();
    expect(ASSET_VERSIONS["wolfpack-lib.js"]).toBeUndefined();
    expect(html).not.toContain("wolfpack-lib.js");
    expect(serviceWorker).not.toContain("wolfpack-lib.js");
  });
});
