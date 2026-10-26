import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSiteAssets, normalizeSiteAssets } from "../../scripts/site-assets";

const CANONICAL = "https://almogdepaz.github.io/wolfpack/";
let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

function hash16(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function hashed(stem: string, ext: string, content: string): string {
  return `${stem}.${hash16(content)}${ext}`;
}

interface FixtureFiles {
  readonly [relativePath: string]: string;
}

const ICON = "<svg>icon</svg>";
const CSS = "body{}";
const JS = "void 0;";
const SHOT = "png-bytes";

function page(refs: { css: string; js: string; icon: string; shot: string }): string {
  return [
    "<!doctype html><html><head>",
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta property="og:type" content="website">',
    `<meta property="og:image" content="${CANONICAL}assets/${refs.shot}">`,
    `<meta name="twitter:image" content="${CANONICAL}assets/${refs.shot}">`,
    `<link rel="canonical" href="${CANONICAL}">`,
    `<link rel="icon" href="assets/${refs.icon}">`,
    `<link rel="stylesheet" href="${refs.css}">`,
    "</head><body>",
    `<a href="#install">Install</a><img src="assets/${refs.shot}" alt="shot">`,
    `<script src="${refs.js}"></script>`,
    "</body></html>",
  ].join("\n");
}

function consistentFiles(): FixtureFiles {
  const refs = {
    css: hashed("styles", ".css", CSS),
    js: hashed("homepage", ".js", JS),
    icon: hashed("wolfpack-icon", ".svg", ICON),
    shot: hashed("desktop-sessions", ".png", SHOT),
  };
  return {
    "index.html": page(refs),
    [refs.css]: CSS,
    [refs.js]: JS,
    [`assets/${refs.icon}`]: ICON,
    "assets/wolfpack-icon.svg": ICON,
    [`assets/${refs.shot}`]: SHOT,
  };
}

function writeSite(files: FixtureFiles): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wolfpack-site-assets-"));
  const siteRoot = join(fixtureRoot, "site");
  mkdirSync(join(siteRoot, "assets"), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(siteRoot, relativePath), content);
  }
  return siteRoot;
}

function listAssets(siteRoot: string): string[] {
  return readdirSync(join(siteRoot, "assets")).sort();
}

describe("site asset normalisation", () => {
  test("accepts a consistent site", () => {
    const siteRoot = writeSite(consistentFiles());
    expect(checkSiteAssets(siteRoot)).toEqual([]);
  });

  test("hashes an unhashed asset, removes its stale sibling and rewrites relative and absolute references", () => {
    const files = { ...consistentFiles() };
    const oldShot = hashed("desktop-sessions", ".png", SHOT);
    files["assets/desktop-sessions.png"] = "new-png-bytes";
    const siteRoot = writeSite(files);

    expect(checkSiteAssets(siteRoot).join("\n")).toContain("assets/desktop-sessions.png");

    normalizeSiteAssets(siteRoot);

    const newShot = hashed("desktop-sessions", ".png", "new-png-bytes");
    expect(existsSync(join(siteRoot, "assets", newShot))).toBe(true);
    expect(existsSync(join(siteRoot, "assets", oldShot))).toBe(false);
    expect(existsSync(join(siteRoot, "assets", "desktop-sessions.png"))).toBe(false);
    const html = readFileSync(join(siteRoot, "index.html"), "utf8");
    expect(html).not.toContain(oldShot);
    expect(html).toContain(`src="assets/${newShot}"`);
    expect(html).toContain(`content="${CANONICAL}assets/${newShot}"`);
    expect(checkSiteAssets(siteRoot)).toEqual([]);
  });

  test("renames a hashed file whose bytes changed in place", () => {
    const files = { ...consistentFiles() };
    const oldCss = hashed("styles", ".css", CSS);
    files[oldCss] = "body{color:red}";
    const siteRoot = writeSite(files);

    expect(checkSiteAssets(siteRoot).join("\n")).toContain(oldCss);

    normalizeSiteAssets(siteRoot);

    const newCss = hashed("styles", ".css", "body{color:red}");
    expect(existsSync(join(siteRoot, oldCss))).toBe(false);
    expect(readFileSync(join(siteRoot, newCss), "utf8")).toBe("body{color:red}");
    expect(readFileSync(join(siteRoot, "index.html"), "utf8")).toContain(`href="${newCss}"`);
    expect(checkSiteAssets(siteRoot)).toEqual([]);
  });

  test("keeps the unhashed icon compatibility copy and hashes it as the source", () => {
    const files = { ...consistentFiles() };
    const oldIcon = hashed("wolfpack-icon", ".svg", ICON);
    files["assets/wolfpack-icon.svg"] = "<svg>new</svg>";
    const siteRoot = writeSite(files);

    expect(checkSiteAssets(siteRoot).join("\n")).toContain("wolfpack-icon.svg");

    normalizeSiteAssets(siteRoot);

    const newIcon = hashed("wolfpack-icon", ".svg", "<svg>new</svg>");
    expect(listAssets(siteRoot)).toEqual([
      hashed("desktop-sessions", ".png", SHOT),
      newIcon,
      "wolfpack-icon.svg",
    ].sort());
    expect(readFileSync(join(siteRoot, "assets", "wolfpack-icon.svg"), "utf8")).toBe("<svg>new</svg>");
    expect(readFileSync(join(siteRoot, "index.html"), "utf8")).toContain(`href="assets/${newIcon}"`);
    expect(checkSiteAssets(siteRoot)).toEqual([]);
  });

  test("normalising a consistent site changes nothing", () => {
    const files = consistentFiles();
    const siteRoot = writeSite(files);
    const before = readFileSync(join(siteRoot, "index.html"), "utf8");
    expect(normalizeSiteAssets(siteRoot)).toEqual({ renamed: [], removed: [], indexRewritten: false });
    expect(readFileSync(join(siteRoot, "index.html"), "utf8")).toBe(before);
    expect(listAssets(siteRoot)).toEqual(
      Object.keys(files).filter((path) => path.startsWith("assets/")).map((path) => path.slice(7)).sort(),
    );
  });

  test("reports missing references, orphans, leading-slash paths and ambiguous hashed siblings", () => {
    const files = { ...consistentFiles() };
    const shot = hashed("desktop-sessions", ".png", SHOT);
    files["index.html"] = files["index.html"]
      .replace("</body>", '<img src="assets/missing.0123456789abcdef.webp" alt=""><img src="/assets/x.png" alt=""></body>');
    files["assets/orphan.0123456789abcdef.webp"] = "orphan";
    files[`assets/desktop-sessions.${"f".repeat(16)}.png`] = "other";
    const siteRoot = writeSite(files);

    const report = checkSiteAssets(siteRoot).join("\n");
    expect(report).toContain("assets/missing.0123456789abcdef.webp");
    expect(report).toContain("/assets/x.png");
    expect(report).toContain("assets/orphan.0123456789abcdef.webp");
    expect(report).toContain(`assets/${shot}`);
    expect(() => normalizeSiteAssets(siteRoot)).toThrow(/desktop-sessions/);
  });

  test("reports git-ignored site files even before they are tracked", () => {
    const siteRoot = writeSite(consistentFiles());
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    writeFileSync(join(fixtureRoot, ".gitignore"), "*.png\n");
    const shot = hashed("desktop-sessions", ".png", SHOT);

    const report = checkSiteAssets(siteRoot, { gitRoot: fixtureRoot }).join("\n");
    expect(report).toContain(`site/assets/${shot}`);
    expect(report).toContain("ignored");
  });
});
