import { describe, expect, test } from "bun:test";
import { ASSET_VERSIONS, assets } from "../../src/public-assets";

describe("per-asset browser cache versions", () => {
  test("index URLs use the corresponding content hash", () => {
    const html = assets.get("index.html")?.content;
    expect(typeof html).toBe("string");
    for (const file of ["styles.css", "wolfpack-lib.js", "ghostty-web.bundle.js", "app.bundle.js"]) {
      expect(html as string).toContain(`/${file}?v=${ASSET_VERSIONS[file]}`);
    }
    expect(new Set(Object.values(ASSET_VERSIONS)).size).toBeGreaterThan(2);
  });

  test("service worker precaches the versioned shell URLs emitted by index", () => {
    const serviceWorker = assets.get("sw.js")?.content;
    expect(typeof serviceWorker).toBe("string");
    for (const file of ["styles.css", "wolfpack-lib.js", "app.bundle.js"]) {
      expect(serviceWorker as string).toContain(`"/${file}?v=${ASSET_VERSIONS[file]}"`);
    }
  });
});
