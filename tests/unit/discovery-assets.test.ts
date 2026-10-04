import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CANONICAL_URL = "https://almogdepaz.github.io/wolfpack/";

function readRepoFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function jsonLdFrom(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("homepage JSON-LD is missing");
  return JSON.parse(match[1]);
}

describe("discovery assets", () => {
  test("uses GitHub Pages as the canonical public URL", () => {
    const homepage = readRepoFile("site/index.html");
    const app = readRepoFile("public/index.html");
    const pagesWorkflow = readRepoFile(".github/workflows/pages.yml");
    const embeddedLlms = readRepoFile("public/llms.txt");
    const fullLlms = readRepoFile("site/llms-full.txt");
    const buildScript = readRepoFile("scripts/build.ts");
    const packageManifest = JSON.parse(readRepoFile("package.json")) as { readonly homepage?: string };

    expect(packageManifest.homepage).toBe(CANONICAL_URL);
    expect(buildScript).toContain(`homepage: "${CANONICAL_URL}"`);
    expect(homepage).toContain(`<link rel="canonical" href="${CANONICAL_URL}">`);
    expect(homepage).toContain(`<meta property="og:url" content="${CANONICAL_URL}">`);
    expect(app).toContain(`<link rel="canonical" href="${CANONICAL_URL}" />`);
    expect(app).toContain(`<meta property="og:url" content="${CANONICAL_URL}" />`);
    expect(embeddedLlms).toContain(`Canonical homepage: ${CANONICAL_URL}`);
    expect(embeddedLlms).not.toContain("Repository and README");
    expect(fullLlms).not.toContain("github.com/almogdepaz/wolfpack#readme");
    expect(pagesWorkflow).not.toContain("Generate Netlify redirect");
    expect(pagesWorkflow).toContain("'site/**'");
    expect(pagesWorkflow).toContain("path: site");

    const jsonLd = jsonLdFrom(homepage);
    expect(jsonLd["@type"]).toBe("SoftwareApplication");
    expect(jsonLd.url).toBe(CANONICAL_URL);
  });

  test("ships crawler assets for the canonical homepage", () => {
    const robots = readRepoFile("site/robots.txt");
    const sitemap = readRepoFile("site/sitemap.xml");

    expect(robots).toContain(`Sitemap: ${CANONICAL_URL}sitemap.xml`);
    expect(sitemap).toContain(`<loc>${CANONICAL_URL}</loc>`);
  });

  test("keeps the Bun package-runner command consistent across discovery surfaces", () => {
    const surfaces = [
      "README.md",
      "docs/installation.md",
      "site/index.html",
      "llms.txt",
      "public/llms.txt",
      "src/public-assets.ts",
    ];

    for (const path of surfaces) {
      const content = readRepoFile(path);
      expect(content).toContain("bunx --bun wolfpack-bridge@latest");
      expect(content).not.toContain("bunx wolfpack-bridge@latest");
    }
  });

  test("pins the privileged Pages deployment actions", () => {
    const workflow = readRepoFile(".github/workflows/pages.yml");

    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(workflow).toContain("actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d");
    expect(workflow).toContain("actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9");
    expect(workflow).toContain("actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e");
  });
});
