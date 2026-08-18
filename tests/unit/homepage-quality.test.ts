import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CANONICAL_HOMEPAGE_URL,
  HOMEPAGE_DIAGNOSTIC_DIRECTORY,
  HOMEPAGE_SCREENSHOT_PROJECTS,
  REPOSITORY_ROOT,
  SITE_ROOT,
  headersForSiteRequest,
  homepageScreenshotPath,
  jsonLdCspHash,
  jsonLdSource,
  readHeaderRules,
  readSiteFile,
  siteAssetHashPrefix,
  validateHomepageSitemap,
} from "../homepage-quality-helpers.ts";
import type { HeaderRule } from "../homepage-quality-helpers.ts";

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
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_CACHE_CONTROL = "public, max-age=0, must-revalidate";

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

function directiveMap(policy: string): ReadonlyMap<string, readonly string[]> {
  return new Map(policy.split(";").map((entry) => {
    const [name = "", ...values] = entry.trim().split(/\s+/);
    return [name, values] as const;
  }).filter(([name]) => name));
}

function headerRule(path: string): HeaderRule {
  const rules = readHeaderRules().filter((rule) => rule.path === path);
  expect(rules).toHaveLength(1);
  const rule = rules[0];
  if (!rule) throw new Error(`missing header rule for ${path}`);
  return rule;
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

function staleAssetPath(assetPath: string): string {
  return assetPath.replace(/\.([0-9a-f])([0-9a-f]{15})(?=\.[^.]+$)/, (_, first, rest) =>
    `.${first === "0" ? "1" : "0"}${rest}`
  );
}

function unhashedAssetPath(assetPath: string): string {
  return assetPath.replace(/\.[0-9a-f]{16}(?=\.[^.]+$)/, "");
}

function deployedSitePath(relativePath: string): string {
  return `${new URL(CANONICAL_HOMEPAGE_URL).pathname}${relativePath}`;
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

  test("keeps canonical-site app asset consumers deployable and revalidated", () => {
    const canonicalOrigin = new URL(CANONICAL_HOMEPAGE_URL).origin;
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
        url.pathname.startsWith(deployedSitePath("assets/"))
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
    for (const requestUrl of [
      compatibilityUrl,
      new URL(`${compatibilityUrl.pathname}?query=cannot-make-immutable`, compatibilityUrl),
    ]) {
      const cacheControl = headersForSiteRequest(requestUrl).get("cache-control");
      expect(cacheControl).toBe(REVALIDATED_CACHE_CONTROL);
      expect(cacheControl).not.toContain("immutable");
    }

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

  test("externalizes executable code and leaves only exact-hashed JSON-LD inline", () => {
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

  test.each([
    [
      "malformed XML",
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL_HOMEPAGE_URL}</loc></url>`,
    ],
    [
      "wrong root",
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL_HOMEPAGE_URL}</loc></url></sitemapindex>`,
    ],
    [
      "wrong namespace",
      `<urlset xmlns="https://example.test/not-sitemap"><url><loc>${CANONICAL_HOMEPAGE_URL}</loc></url></urlset>`,
    ],
    [
      "duplicate direct url",
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL_HOMEPAGE_URL}</loc></url><url/></urlset>`,
    ],
    [
      "duplicate direct loc",
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL_HOMEPAGE_URL}</loc><loc>${CANONICAL_HOMEPAGE_URL}</loc></url></urlset>`,
    ],
    [
      "noncanonical loc",
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/</loc></url></urlset>`,
    ],
  ])("rejects %s through the shared sitemap validator", (_name, sitemap) => {
    expect(validateHomepageSitemap(sitemap)).not.toEqual([]);
  });

  test("derives a restrictive functional policy from the exact JSON-LD bytes", () => {
    const global = headerRule("/*");
    const policy = global.headers.get("content-security-policy") ?? "";
    const directives = directiveMap(policy);
    const expectedJsonLdHash = `'sha256-${jsonLdCspHash(HOMEPAGE)}'`;

    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(new Set(directives.get("script-src"))).toEqual(
      new Set(["'self'", expectedJsonLdHash]),
    );
    expect(new Set(directives.get("style-src"))).toEqual(
      new Set(["'self'", "https://fonts.googleapis.com"]),
    );
    expect(directives.get("font-src")).toEqual(["https://fonts.gstatic.com"]);
    expect(new Set(directives.get("img-src"))).toEqual(new Set(["'self'", "data:"]));
    expect(directives.get("media-src")).toEqual(["'self'"]);
    expect(new Set(directives.get("connect-src"))).toEqual(
      new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]),
    );
    for (const directive of ["base-uri", "frame-ancestors", "object-src", "form-action", "frame-src", "worker-src"]) {
      expect(directives.get(directive)).toEqual(["'none'"]);
    }
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https:\/\/(?!fonts\.(?:googleapis|gstatic)\.com)/);

    expect(global.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(oneAttribute('meta[name="referrer"]', "content"))
      .toBe("strict-origin-when-cross-origin");
    expect(global.headers.get("x-content-type-options")).toBe("nosniff");
    const permissions = global.headers.get("permissions-policy") ?? "";
    expect(permissions).toContain("clipboard-write=(self)");
    for (const capability of ["camera", "geolocation", "microphone", "payment", "usb"]) {
      expect(permissions).toContain(`${capability}=()`);
    }
  });

  test("matches static header rules by pathname and caches only exact hashed assets", () => {
    const rules = readHeaderRules();
    const global = headerRule("/*");
    const renderAssets = renderAssetPaths();
    const expectedPaths = new Set(renderAssets.map(deployedSitePath));
    const immutableRules = rules.filter((rule) =>
      rule.headers.get("cache-control")?.includes("immutable") === true
    );

    expect(global.headers.get("cache-control")).toBe(REVALIDATED_CACHE_CONTROL);
    expect(new Set(immutableRules.map(({ path }) => path))).toEqual(expectedPaths);
    for (const asset of renderAssets) {
      const pathname = deployedSitePath(asset);
      const exactHeaders = headersForSiteRequest(
        new URL(pathname, CANONICAL_HOMEPAGE_URL),
      );
      const queryHeaders = headersForSiteRequest(
        new URL(`${pathname}?cache-bust=ignored`, CANONICAL_HOMEPAGE_URL),
      );
      expect(exactHeaders.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(queryHeaders).toEqual(exactHeaders);

      for (const nonFingerprintedPath of [
        unhashedAssetPath(pathname),
        staleAssetPath(pathname),
      ]) {
        expect(headersForSiteRequest(
          new URL(nonFingerprintedPath, CANONICAL_HOMEPAGE_URL),
        ).get("cache-control")).toBe(REVALIDATED_CACHE_CONTROL);
        expect(headersForSiteRequest(
          new URL(`${nonFingerprintedPath}?v=${siteAssetHashPrefix(asset)}`, CANONICAL_HOMEPAGE_URL),
        ).get("cache-control")).toBe(REVALIDATED_CACHE_CONTROL);
      }
    }
    for (const path of [
      "/",
      "/index.html",
      "/_headers",
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/llms-full.txt",
      "/unknown",
    ]) {
      expect(headersForSiteRequest(
        new URL(`${path.slice(1)}?query=cannot-match-a-rule`, CANONICAL_HOMEPAGE_URL),
      ).get("cache-control")).toBe(REVALIDATED_CACHE_CONTROL);
    }
  });

  test("retains and immediately uploads one ignored screenshot per homepage project", () => {
    const workflow = readFileSync(
      join(REPOSITORY_ROOT, ".github", "workflows", "test.yml"),
      "utf8",
    );
    const browserInstallIndex = workflow.indexOf("Install critical Playwright browsers");
    const homepageQaIndex = workflow.indexOf("Run homepage quality and resilience QA");
    const uploadIndex = workflow.indexOf("Upload homepage QA diagnostics");
    const laterPlaywrightIndex = workflow.indexOf("Run critical Chromium desktop and mobile E2E");
    const namedSteps = [...workflow.matchAll(/^      - name: (.+)$/gm)]
      .map((match) => match[1] ?? "");
    const homepageStepIndex = namedSteps.indexOf("Run homepage quality and resilience QA");
    const screenshotPaths = HOMEPAGE_SCREENSHOT_PROJECTS.map(homepageScreenshotPath);

    expect(HOMEPAGE_SCREENSHOT_PROJECTS).toEqual([
      "desktop",
      "iphone-se",
      "iphone-14",
    ]);
    expect(screenshotPaths).toEqual([
      join(HOMEPAGE_DIAGNOSTIC_DIRECTORY, "homepage-desktop.png"),
      join(HOMEPAGE_DIAGNOSTIC_DIRECTORY, "homepage-iphone-se.png"),
      join(HOMEPAGE_DIAGNOSTIC_DIRECTORY, "homepage-iphone-14.png"),
    ]);
    expect(HOMEPAGE_DIAGNOSTIC_DIRECTORY.startsWith(
      join(REPOSITORY_ROOT, "tests", "e2e", "test-results"),
    )).toBe(false);
    for (const screenshotPath of screenshotPaths) {
      const repositoryPath = relative(REPOSITORY_ROOT, screenshotPath);
      const check = spawnSync(
        "git",
        ["check-ignore", "--quiet", "--", repositoryPath],
        { cwd: REPOSITORY_ROOT },
      );
      expect(check.status).toBe(0);
    }

    expect(browserInstallIndex).toBeGreaterThan(-1);
    expect(homepageQaIndex).toBeGreaterThan(browserInstallIndex);
    expect(uploadIndex).toBeGreaterThan(homepageQaIndex);
    expect(laterPlaywrightIndex).toBeGreaterThan(uploadIndex);
    expect(namedSteps[homepageStepIndex + 1]).toBe("Upload homepage QA diagnostics");
    expect(workflow).toContain(
      "bunx playwright test tests/e2e/homepage-install.e2e.ts --project=desktop --project=iphone-se --project=iphone-14",
    );
    const uploadStep = workflow.slice(uploadIndex, laterPlaywrightIndex);
    expect(uploadStep).toContain("if: always()");
    expect(uploadStep).toContain(
      "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
    );
    expect(uploadStep).toContain("name: homepage-quality-diagnostics");
    expect(uploadStep).toContain("path: artifacts/homepage-quality");
    expect(uploadStep).toContain("if-no-files-found: error");
  });
});
