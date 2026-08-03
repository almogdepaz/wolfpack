import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CANONICAL_URL = "https://get-wolfpack.netlify.app/";

function readRepoFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function jsonLdFrom(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("homepage JSON-LD is missing");
  return JSON.parse(match[1]);
}

describe("discovery assets", () => {
  test("publishes the canonical homepage metadata", () => {
    const homepage = readRepoFile("site/index.html");

    expect(homepage).toContain(`<link rel="canonical" href="${CANONICAL_URL}">`);
    expect(homepage).toContain(`<meta property="og:url" content="${CANONICAL_URL}">`);
    expect(homepage).toContain("<meta name=\"twitter:card\" content=\"summary_large_image\">");

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

  test("links machine-readable and README discovery to the canonical homepage", () => {
    expect(readRepoFile("README.md")).toContain(CANONICAL_URL);
    expect(readRepoFile("llms.txt")).toContain(CANONICAL_URL);
  });

  test("provides a privacy-respecting feedback template for multi-machine trials", () => {
    const template = readRepoFile("docs/multi-machine-trial-feedback.md");

    expect(template).toContain("## Setup timeline");
    expect(template).toContain("## First remote session");
    expect(template).toContain("Do not include terminal output, project names, Tailscale URLs, or credentials.");
  });

  test("pins the privileged Pages deployment actions", () => {
    const workflow = readRepoFile(".github/workflows/pages.yml");

    expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain("actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b");
    expect(workflow).toContain("actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa");
    expect(workflow).toContain("actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e");
  });
});
