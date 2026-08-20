import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOMEPAGE = readFileSync(join(process.cwd(), "site", "index.html"), "utf8");
const CURL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash";
const BUNX_COMMAND = "bunx wolfpack-bridge@latest";
const NPX_COMMAND = "npx --yes wolfpack-bridge@latest";
const REPOSITORY_URL = "https://github.com/almogdepaz/wolfpack";

interface ElementAttributes {
  readonly [name: string]: string;
}

function attributesFor(selector: string): ElementAttributes[] {
  const matches: ElementAttributes[] = [];
  new HTMLRewriter().on(selector, {
    element(element) {
      matches.push(Object.fromEntries(element.attributes));
    },
  }).transform(HOMEPAGE);
  return matches;
}

function textFor(selector: string): string[] {
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
  }).transform(HOMEPAGE);
  return matches.map((value) => value.trim());
}

describe("homepage install path", () => {
  test("routes every primary Install Wolfpack CTA to one semantic section", () => {
    const installSections = attributesFor("section#install[aria-labelledby]");
    const installCtas = attributesFor("a.install-cta");

    expect(installSections).toHaveLength(1);
    expect(installCtas).toHaveLength(3);
    expect(installCtas.map(({ href }) => href)).toEqual(["#install", "#install", "#install"]);
    expect(textFor("a.install-cta")).toEqual([
      "Install Wolfpack",
      "Install Wolfpack",
      "Install Wolfpack",
    ]);
    expect(HOMEPAGE).not.toContain("Join the pack");
    expect(HOMEPAGE.indexOf("Become a tester")).toBeGreaterThan(HOMEPAGE.indexOf('id="install"'));
  });

  test("keeps every install and doctor command fully visible without clipboard dependence", () => {
    expect(textFor("code[data-install-command]")).toEqual([
      CURL_COMMAND,
      BUNX_COMMAND,
      NPX_COMMAND,
    ]);
    expect(textFor("code[data-doctor-command]")).toEqual([
      "wolfpack doctor",
      `${BUNX_COMMAND} doctor`,
      `${NPX_COMMAND} doctor`,
    ]);
    expect(HOMEPAGE).not.toContain("raw.githubusercontent.com/...");

    const copyButtons = attributesFor("button[data-copy-command]");
    expect(copyButtons.map((button) => button["data-copy-command"])).toEqual([
      CURL_COMMAND,
      BUNX_COMMAND,
      NPX_COMMAND,
    ]);
    expect(copyButtons.every((button) => button["aria-describedby"]?.length)).toBe(true);
  });

  test("states exact targets, optional prerequisites, and native installer effects", () => {
    for (const statement of [
      "Supported targets: macOS arm64/x64 and Linux x64/arm64.",
      "An agent CLI is optional because Shell works.",
      "Tailscale is optional for local-only and required for private phone/remote access.",
      "Bunx and npm make no persistent PATH change.",
      "What the installer changes",
      "GitHub release",
      "checksums-sha256.txt",
      "~/.wolfpack/bin",
      "/usr/local/bin/wolfpack",
      "setup",
    ]) {
      expect(HOMEPAGE).toContain(statement);
    }
    expect(attributesFor("details.installer-changes")).toHaveLength(1);
  });

  test("links activation, recovery, releases, checksums, and trust resources safely", () => {
    const requiredHrefs = [
      `${REPOSITORY_URL}/blob/main/docs/installation.md`,
      `${REPOSITORY_URL}/blob/main/docs/first-session.md`,
      `${REPOSITORY_URL}/blob/main/docs/troubleshooting.md`,
      `${REPOSITORY_URL}/releases/latest`,
      `${REPOSITORY_URL}/releases/latest/download/checksums-sha256.txt`,
      `${REPOSITORY_URL}/blob/main/docs/installation.md#security-and-trust`,
    ];
    const resourceLinks = attributesFor(".install-resources a");

    expect(resourceLinks.map(({ href }) => href)).toEqual(requiredHrefs);
    for (const link of resourceLinks) {
      expect(link.target).toBe("_blank");
      expect(new Set((link.rel ?? "").split(/\s+/))).toEqual(new Set(["noopener", "noreferrer"]));
    }

    for (const link of attributesFor('a[target="_blank"]')) {
      expect(new Set((link.rel ?? "").split(/\s+/))).toEqual(new Set(["noopener", "noreferrer"]));
    }
  });
});
