import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_HOMEPAGE_URL,
  REPOSITORY_ROOT,
  SITE_ROOT,
  jsonLdSource,
  readSiteFile,
  siteAssetHashPrefix,
  validateHomepageSitemap,
} from "../homepage-quality-helpers.ts";

const HOMEPAGE = readFileSync(join(SITE_ROOT, "index.html"), "utf8");
const APP_DOCUMENT = readFileSync(
  join(REPOSITORY_ROOT, "public", "index.html"),
  "utf8",
);
const RENDER_ASSET_SPECS = [
  { directory: "", stem: "styles", extension: ".css", compatibilityFileName: undefined },
  { directory: "", stem: "homepage", extension: ".js", compatibilityFileName: undefined },
  {
    directory: "assets",
    stem: "wolfpack-icon",
    extension: ".svg",
    compatibilityFileName: "wolfpack-icon.svg",
  },
  {
    directory: "assets",
    stem: "desktop-sessions",
    extension: ".png",
    compatibilityFileName: undefined,
  },
  {
    directory: "assets",
    stem: "desktop-terminal",
    extension: ".png",
    compatibilityFileName: undefined,
  },
  {
    directory: "assets",
    stem: "mobile-sessions",
    extension: ".webp",
    compatibilityFileName: undefined,
  },
  {
    directory: "assets",
    stem: "mobile-terminal",
    extension: ".webp",
    compatibilityFileName: undefined,
  },
  {
    directory: "assets",
    stem: "wolfpack-usage-demo",
    extension: ".mp4",
    compatibilityFileName: undefined,
  },
] as const;
interface ElementAttributes {
  readonly [name: string]: string;
}

function attributesForDocument(
  document: string,
  selector: string,
): ElementAttributes[] {
  const matches: ElementAttributes[] = [];
  new HTMLRewriter().on(selector, {
    element(element) {
      matches.push(Object.fromEntries(element.attributes));
    },
  }).transform(document);
  return matches;
}

function attributesFor(selector: string): ElementAttributes[] {
  return attributesForDocument(HOMEPAGE, selector);
}

function oneAttribute(selector: string, name: string): string {
  const matches = attributesFor(selector);
  expect(matches).toHaveLength(1);
  const value = matches[0]?.[name];
  expect(value).toBeDefined();
  return value ?? "";
}

function renderAssetPaths(): readonly string[] {
  return RENDER_ASSET_SPECS.map(({
    directory,
    stem,
    extension,
    compatibilityFileName,
  }) => {
    const candidates = readdirSync(join(SITE_ROOT, directory))
      .filter((fileName) => fileName.startsWith(`${stem}.`) && fileName.endsWith(extension));
    const hashedCandidates = candidates.filter((fileName) =>
      fileName !== compatibilityFileName
    );
    expect(candidates).toHaveLength(compatibilityFileName ? 2 : 1);
    expect(hashedCandidates).toHaveLength(1);
    const fileName = hashedCandidates[0] ?? "";
    const match = fileName.match(
      new RegExp(`^${stem}\\.([0-9a-f]{16})\\${extension}$`),
    );
    expect(match).not.toBeNull();
    return directory ? `${directory}/${fileName}` : fileName;
  });
}

function siteRelativePath(url: URL): string {
  const siteRoot = new URL(CANONICAL_HOMEPAGE_URL).pathname;
  if (!url.pathname.startsWith(siteRoot)) {
    throw new Error(`homepage asset is outside ${siteRoot}: ${url.pathname}`);
  }
  return decodeURIComponent(url.pathname.slice(siteRoot.length));
}

function firstPartyRenderUrls(): URL[] {
  const values = [
    ...attributesFor('link[rel="icon"]').map(({ href }) => href),
    ...attributesFor('link[rel="stylesheet"]').map(({ href }) => href),
    ...attributesFor("script[src]").map(({ src }) => src),
    ...attributesFor("source[src]").map(({ src }) => src),
    ...attributesFor("img[src]").map(({ src }) => src),
    ...attributesFor('meta[property="og:image"]').map(({ content }) => content),
    ...attributesFor('meta[name="twitter:image"]').map(({ content }) => content),
  ].filter((value): value is string => value !== undefined);
  return values
    .map((value) => new URL(value, CANONICAL_HOMEPAGE_URL))
    .filter((url) => url.origin === new URL(CANONICAL_HOMEPAGE_URL).origin);
}

describe("homepage quality contract", () => {
  test("derives every unique deployable render filename hash from its file bytes", () => {
    const renderAssets = renderAssetPaths();
    const referencedPaths = new Set<string>();

    for (const url of firstPartyRenderUrls()) {
      const relativePath = siteRelativePath(url);
      expect(renderAssets).toContain(relativePath);
      expect(existsSync(join(SITE_ROOT, relativePath))).toBe(true);
      expect(url.search).toBe("");
      referencedPaths.add(relativePath);
    }
    for (const relativePath of renderAssets) {
      const encodedHash = relativePath.match(/\.([0-9a-f]{16})\.[^.]+$/)?.[1];
      expect(encodedHash).toBe(siteAssetHashPrefix(relativePath));
    }

    expect(referencedPaths).toEqual(new Set(renderAssets));
  });

  test("keeps every referenced first-party render file visible to git", () => {
    const referencedFiles = new Set(firstPartyRenderUrls().map((url) =>
      `site/${siteRelativePath(url)}`
    ));
    const ignoredFiles = [...referencedFiles].filter((relativePath) => {
      const check = spawnSync(
        "git",
        ["check-ignore", "--quiet", "--", relativePath],
        { cwd: REPOSITORY_ROOT },
      );
      if (check.status !== 0 && check.status !== 1) {
        throw new Error(`git check-ignore failed for ${relativePath}`);
      }
      return check.status === 0;
    });

    expect(ignoredFiles).toEqual([]);
  });

  test("keeps canonical-site app asset consumers deployable", () => {
    const canonicalOrigin = new URL(CANONICAL_HOMEPAGE_URL).origin;
    const canonicalAssetsPath = new URL("assets/", CANONICAL_HOMEPAGE_URL).pathname;
    const consumerValues = [
      ...attributesForDocument(APP_DOCUMENT, "meta[content]").map(({ content }) => content),
      ...attributesForDocument(APP_DOCUMENT, "link[href]").map(({ href }) => href),
      ...attributesForDocument(APP_DOCUMENT, "script[src]").map(({ src }) => src),
      ...attributesForDocument(APP_DOCUMENT, "source[src]").map(({ src }) => src),
      ...attributesForDocument(APP_DOCUMENT, "img[src]").map(({ src }) => src),
    ].filter((value): value is string => value !== undefined);
    const canonicalAssetUrls = consumerValues
      .map((value) => new URL(value, CANONICAL_HOMEPAGE_URL))
      .filter((url) =>
        url.origin === canonicalOrigin &&
        url.pathname.startsWith(canonicalAssetsPath)
      );

    expect(canonicalAssetUrls.map(({ href }) => href)).toEqual([
      "https://almogdepaz.github.io/wolfpack/assets/wolfpack-icon.svg",
    ]);
    const compatibilityUrl = canonicalAssetUrls[0];
    expect(compatibilityUrl).toBeDefined();
    if (!compatibilityUrl) throw new Error("missing canonical compatibility asset URL");

    expect(firstPartyRenderUrls().some((url) =>
      url.pathname === compatibilityUrl.pathname
    )).toBe(false);
    const sitePath = siteRelativePath(compatibilityUrl);
    expect(existsSync(join(SITE_ROOT, sitePath))).toBe(true);
    const hashedIconPath = renderAssetPaths().find((path) =>
      /^assets\/wolfpack-icon\.[0-9a-f]{16}\.svg$/.test(path)
    );
    expect(hashedIconPath).toBeDefined();
    if (hashedIconPath) {
      expect(readSiteFile(sitePath)).toEqual(readSiteFile(hashedIconPath));
    }
  });

  test("externalizes executable code and leaves only JSON-LD inline", () => {
    const scripts = attributesFor("script");
    const externalScripts = scripts.filter(({ src }) => src);
    const inlineScripts = scripts.filter(({ src }) => !src);

    expect(externalScripts).toHaveLength(1);
    expect(siteRelativePath(
      new URL(externalScripts[0]?.src ?? "", CANONICAL_HOMEPAGE_URL),
    )).toMatch(/^homepage\.[0-9a-f]{16}\.js$/);
    expect(inlineScripts).toEqual([{ type: "application/ld+json" }]);
    expect(HOMEPAGE).not.toContain("navigator.clipboard");
  });

  test("resolves every same-document fragment to exactly one id", () => {
    const idCounts = new Map<string, number>();
    for (const { id } of attributesFor("[id]")) {
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    for (const { href } of attributesFor('a[href^="#"]')) {
      expect(href).toBeDefined();
      const fragment = decodeURIComponent((href ?? "").slice(1));
      expect(idCounts.get(fragment)).toBe(1);
    }
  });

  test("keeps external URLs valid and new-tab links isolated", () => {
    const externalValues = [
      ...attributesFor("a[href]").map(({ href }) => href),
      ...attributesFor("link[href]").map(({ href }) => href),
      ...attributesFor("img[src]").map(({ src }) => src),
      ...attributesFor("script[src]").map(({ src }) => src),
      ...attributesFor("source[src]").map(({ src }) => src),
      ...attributesFor('meta[property="og:image"]').map(({ content }) => content),
      ...attributesFor('meta[name="twitter:image"]').map(({ content }) => content),
    ].filter((value): value is string => value?.startsWith("http") === true);

    for (const value of externalValues) {
      expect(() => new URL(value)).not.toThrow();
      expect(new URL(value).protocol).toBe("https:");
    }
    for (const link of attributesFor('a[target="_blank"]')) {
      expect(new Set((link.rel ?? "").split(/\s+/))).toEqual(
        new Set(["noopener", "noreferrer"]),
      );
    }
  });

  test("keeps canonical metadata, sitemap, and SoftwareApplication JSON-LD consistent", () => {
    const canonical = oneAttribute('link[rel="canonical"]', "href");
    const description = oneAttribute('meta[name="description"]', "content");
    const robots = oneAttribute('meta[name="robots"]', "content");
    const referrer = oneAttribute('meta[name="referrer"]', "content");
    const themeColor = oneAttribute('meta[name="theme-color"]', "content");
    const openGraphUrl = oneAttribute('meta[property="og:url"]', "content");
    const openGraphImage = oneAttribute('meta[property="og:image"]', "content");
    const twitterImage = oneAttribute('meta[name="twitter:image"]', "content");
    const jsonLd = JSON.parse(jsonLdSource(HOMEPAGE)) as Record<string, unknown>;
    const sitemap = readFileSync(join(SITE_ROOT, "sitemap.xml"), "utf8");
    const robotsText = readFileSync(join(SITE_ROOT, "robots.txt"), "utf8");

    expect(canonical).toBe(CANONICAL_HOMEPAGE_URL);
    expect(description.length).toBeGreaterThan(40);
    expect(robots).toBe("index, follow");
    expect(referrer).toBe("strict-origin-when-cross-origin");
    expect(themeColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(openGraphUrl).toBe(canonical);
    expect(new URL(openGraphImage).origin).toBe(new URL(canonical).origin);
    expect(twitterImage).toBe(openGraphImage);
    expect(attributesFor('meta[property^="og:"]')).toHaveLength(5);
    expect(attributesFor('meta[name^="twitter:"]')).toHaveLength(4);
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("SoftwareApplication");
    expect(jsonLd.url).toBe(canonical);
    expect(jsonLd.name).toBe("Wolfpack");
    expect(jsonLd.applicationCategory).toBe("DeveloperApplication");
    expect(validateHomepageSitemap(sitemap)).toEqual([]);
    expect(robotsText).toContain(`Sitemap: ${canonical}sitemap.xml`);
  });
});
