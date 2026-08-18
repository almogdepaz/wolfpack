import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPOSITORY_ROOT = join(import.meta.dirname, "..");
export const SITE_ROOT = join(REPOSITORY_ROOT, "site");
export const HOMEPAGE_DIAGNOSTIC_DIRECTORY = join(
  REPOSITORY_ROOT,
  "artifacts",
  "homepage-quality",
);
export const HOMEPAGE_SCREENSHOT_PROJECTS = [
  "desktop",
  "iphone-se",
  "iphone-14",
] as const;
export const CANONICAL_HOMEPAGE_URL = "https://almogdepaz.github.io/wolfpack/";

const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

export interface HeaderRule {
  readonly path: string;
  readonly headers: ReadonlyMap<string, string>;
}

export function homepageScreenshotPath(projectName: string): string {
  if (!HOMEPAGE_SCREENSHOT_PROJECTS.some((name) => name === projectName)) {
    throw new Error(`unsupported homepage screenshot project: ${projectName}`);
  }
  return join(HOMEPAGE_DIAGNOSTIC_DIRECTORY, `homepage-${projectName}.png`);
}

export function readSiteFile(relativePath: string): Buffer {
  return readFileSync(join(SITE_ROOT, relativePath));
}

export function siteAssetHashPrefix(relativePath: string): string {
  return createHash("sha256")
    .update(readSiteFile(relativePath))
    .digest("hex")
    .slice(0, 16);
}

export function validateHomepageSitemap(document: string): readonly string[] {
  const parseErrors: string[] = [];
  let root: Element | null;
  try {
    root = new DOMParser({
      onError: (level, message) => parseErrors.push(`${level}: ${message}`),
    }).parseFromString(document, "application/xml").documentElement;
  } catch (error) {
    return [
      `invalid sitemap XML: ${parseErrors[0] ?? (error instanceof Error ? error.message : String(error))}`,
    ];
  }
  if (parseErrors.length > 0) return [`invalid sitemap XML: ${parseErrors[0]}`];
  if (!root) return ["sitemap XML must contain a document element"];
  if (root.tagName !== "urlset") {
    return ["sitemap document element must be urlset"];
  }

  const errors: string[] = [];
  if (root.namespaceURI !== SITEMAP_NAMESPACE) {
    errors.push(`sitemap namespace must equal ${SITEMAP_NAMESPACE}`);
  }

  const urls = directChildElements(root, "url");
  if (urls.length !== 1) {
    errors.push("sitemap urlset must contain exactly one direct url element");
    return errors;
  }

  const locations = directChildElements(urls[0], "loc");
  if (locations.length !== 1) {
    errors.push("sitemap url must contain exactly one direct loc element");
    return errors;
  }
  if (locations[0]?.textContent !== CANONICAL_HOMEPAGE_URL) {
    errors.push("sitemap loc must equal the canonical homepage URL");
  }
  return errors;
}

function directChildElements(parent: Element, tagName: string): readonly Element[] {
  const matches: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.nodeName === tagName) {
      matches.push(child as Element);
    }
  }
  return matches;
}

export function jsonLdSource(document: string): string {
  const openingTag = '<script type="application/ld+json">';
  const start = document.indexOf(openingTag);
  if (start < 0) throw new Error("homepage JSON-LD opening tag is missing");
  const contentStart = start + openingTag.length;
  const end = document.indexOf("</script>", contentStart);
  if (end < 0) throw new Error("homepage JSON-LD closing tag is missing");
  return document.slice(contentStart, end);
}

export function jsonLdCspHash(document: string): string {
  return createHash("sha256")
    .update(Buffer.from(jsonLdSource(document), "utf8"))
    .digest("base64");
}

export function headersForSiteRequest(requestUrl: URL): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  for (const rule of readHeaderRules()) {
    if (rule.path !== "/*" && rule.path !== requestUrl.pathname) continue;
    for (const [name, value] of rule.headers) headers.set(name, value);
  }
  return headers;
}

export function readHeaderRules(): readonly HeaderRule[] {
  const headersPath = join(SITE_ROOT, "_headers");
  if (!existsSync(headersPath)) return [];

  const rules: Array<{ path: string; headers: Map<string, string> }> = [];
  for (const line of readFileSync(headersPath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), headers: new Map() });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) throw new Error("header appears before a path rule");
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error(`invalid header line: ${line}`);
    rule.headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return rules;
}
