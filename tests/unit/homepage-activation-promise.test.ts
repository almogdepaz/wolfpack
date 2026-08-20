import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = process.cwd();
const HOMEPAGE = readFileSync(join(REPOSITORY_ROOT, "site", "index.html"), "utf8");
const AGENT_OVERVIEW = readFileSync(
  join(REPOSITORY_ROOT, "site", "llms-full.txt"),
  "utf8",
);
const CURL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash";
const INSTALLATION_GUIDE_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/installation.md";
const TROUBLESHOOTING_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/troubleshooting.md";
const LOCAL_TAILSCALE_BOUNDARY =
  "Tailscale is optional for local-only and required for private phone/remote access.";
const SETUP_CHOICES = [
  "projects directory",
  "port",
  "optional Tailscale remote access",
  "optional Pi integration when Pi is detected",
  "whether Wolfpack starts at login",
] as const;
const UNSUPPORTED_SPEED_CLAIMS = [
  /\binstall(?:ation)? in minutes?\b/i,
  /\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?)\b/i,
  /\b(?:instant|fast|effortless) setup\b/i,
  /\b(?:median|percentile|p50|p90|p95|p99)\b/i,
  /\bplaywright\b/i,
  /\bqa budget\b/i,
] as const;

function textFor(document: string, selector: string): readonly string[] {
  const matches: string[] = [];
  new HTMLRewriter().on(selector, {
    element() {
      matches.push("");
    },
    text(text) {
      const index = matches.length - 1;
      const current = matches[index];
      if (current !== undefined) matches[index] = current + text.text;
    },
  }).transform(document);
  return matches.map(value => value.replace(/\s+/g, " ").trim());
}

function oneText(document: string, selector: string): string {
  const matches = textFor(document, selector);
  expect(matches).toHaveLength(1);
  return matches[0] ?? "";
}

function hrefsFor(document: string, selector: string): readonly string[] {
  const hrefs: string[] = [];
  new HTMLRewriter().on(selector, {
    element(element) {
      const href = element.getAttribute("href");
      if (href !== null) hrefs.push(href);
    },
  }).transform(document);
  return hrefs;
}

function markdownH2Section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThan(-1);
  const endOffset = lines.slice(start + 1).findIndex(line => line.startsWith("## "));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n").trim();
}

function unsupportedSpeedClaims(text: string): readonly string[] {
  return UNSUPPORTED_SPEED_CLAIMS
    .filter(pattern => pattern.test(text))
    .map(pattern => pattern.source);
}

describe("substantiated homepage activation promise", () => {
  test("keeps unique stable activation regions and the local/Tailscale boundary", () => {
    expect(oneText(HOMEPAGE, ".install-heading > p")).not.toBe("");
    expect(oneText(HOMEPAGE, ".final-cta > p:not(.community-links)")).not.toBe("");
    expect(textFor(HOMEPAGE, "details.installer-changes > div > p")).toHaveLength(4);
    expect(textFor(HOMEPAGE, ".install-requirements li")).toContain(
      LOCAL_TAILSCALE_BOUNDARY,
    );
  });

  test("keeps the installer command and canonical details/recovery links", () => {
    expect(textFor(HOMEPAGE, "#command-persistent")).toEqual([CURL_COMMAND]);
    const resourceLinks = hrefsFor(HOMEPAGE, ".install-resources a");
    expect(resourceLinks.filter(href => href === INSTALLATION_GUIDE_URL)).toHaveLength(1);
    expect(resourceLinks.filter(href => href === TROUBLESHOOTING_URL)).toHaveLength(1);
  });

  test("discloses all five setup choices without imposing prose grammar", () => {
    const setupChoiceParagraphs = textFor(
      HOMEPAGE,
      "details.installer-changes > div > p",
    ).filter(paragraph => paragraph.includes("projects directory"));
    expect(setupChoiceParagraphs).toHaveLength(1);
    const disclosure = setupChoiceParagraphs[0] ?? "";

    for (const choice of SETUP_CHOICES) expect(disclosure).toContain(choice);
  });

  test("keeps the agent overview on installer-led setup and verification", () => {
    const install = markdownH2Section(AGENT_OVERVIEW, "Install");
    expect(install).toContain(CURL_COMMAND);
    expect(install).toContain("installer immediately launches guided setup");
    expect(install).not.toContain("Then run `wolfpack`, complete setup");
    expect(install).toContain("wolfpack doctor");
    expect(install).toContain("matching prebuilt `wolfpack` and `wolfpack-broker` binaries");
    expect(unsupportedSpeedClaims(install)).toEqual([]);
  });

  test("keeps designated promise regions free of unsupported timing claims", () => {
    const promiseRegions = [
      oneText(HOMEPAGE, ".install-heading > p"),
      ...textFor(HOMEPAGE, "details.installer-changes > div > p"),
      oneText(HOMEPAGE, ".final-cta > p:not(.community-links)"),
    ].join("\n");
    expect(unsupportedSpeedClaims(promiseRegions)).toEqual([]);

    const timingRegression = `${promiseRegions}\nInstall in 2 minutes.`;
    expect(unsupportedSpeedClaims(timingRegression)).not.toEqual([]);
  });
});
