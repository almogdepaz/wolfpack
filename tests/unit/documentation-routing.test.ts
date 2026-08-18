import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const root = process.cwd();
const CANONICAL_SECURITY_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/installation.md#security-and-trust";
const DOCS_ROUTER_PATH = "docs/README.md";
const ROUTER_AUDIENCE_TARGETS = {
  "use Wolfpack": [
    "installation.md",
    "first-session.md",
    "phone-pwa-notifications.md",
    "troubleshooting.md",
  ],
  "operate Wolfpack": [
    "multi-machine-control-room.md",
    "multi-machine-trial-feedback.md",
    "session-identity.md",
  ],
  "automate Wolfpack": [
    "cli-attach.md",
    "session-control.md",
    "agent-skills.md",
    "task-gateway.md",
    "control-api-schema.md",
  ],
  "develop Wolfpack": [
    "../CONTRIBUTING.md",
    "broker-protocol.md",
    "live-update-handoff.md",
    "accessibility-testing.md",
    "tailnet-release-matrix.md",
  ],
} as const;

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackFile[];
}

interface RouterEntry {
  readonly label: string;
  readonly target: string;
  readonly description: string;
}

interface MarkdownReference {
  readonly target: string;
  readonly fragment: string;
}

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function visibleRepositoryFiles(): ReadonlySet<string> {
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode, listed.stderr.toString()).toBe(0);
  return new Set(listed.stdout.toString().trim().split("\n").filter(Boolean));
}

function packedFiles(): ReadonlySet<string> {
  const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(pack.exitCode, pack.stderr.toString()).toBe(0);

  const results = JSON.parse(pack.stdout.toString()) as readonly PackResult[];
  const result = results[0];
  expect(result).toBeDefined();
  return new Set(result?.files.map((file) => file.path));
}

function markdownLinks(markdown: string): readonly string[] {
  const links: string[] = [];
  Bun.markdown.render(markdown, {
    link: (children, { href }) => {
      links.push(href);
      return children;
    },
  });
  return links;
}

function relativeMarkdownReferences(markdownPath: string): readonly MarkdownReference[] {
  return markdownLinks(readRepoFile(markdownPath)).flatMap((href) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return [];
    const [pathAndQuery = "", rawFragment = ""] = href.split("#", 2);
    const file = pathAndQuery.split("?", 1)[0] ?? "";
    return [{
      target: file === ""
        ? markdownPath
        : posix.normalize(posix.join(posix.dirname(markdownPath), file)),
      fragment: decodeURIComponent(rawFragment),
    }];
  });
}

function relativeMarkdownTargets(markdownPath: string): readonly string[] {
  return relativeMarkdownReferences(markdownPath)
    .filter(({ target, fragment }) => target !== markdownPath || fragment === "")
    .map(({ target }) => target);
}

function routerAudienceEntries(markdown: string): ReadonlyMap<string, readonly RouterEntry[]> {
  const sections = new Map<string, RouterEntry[]>();
  let currentAudience: string | undefined;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^## (.+)$/)?.[1];
    if (heading !== undefined) {
      currentAudience = heading;
      sections.set(heading, []);
      continue;
    }
    const entry = line.match(/^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/);
    if (!entry || currentAudience === undefined) continue;
    sections.get(currentAudience)?.push({
      label: entry[1] ?? "",
      target: entry[2] ?? "",
      description: entry[3] ?? "",
    });
  }
  return sections;
}

function markdownH2Section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThan(-1);
  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function markdownHeadingIds(markdownPath: string): ReadonlySet<string> {
  const headingIds = new Set<string>();
  Bun.markdown.render(readRepoFile(markdownPath), {
    heading: (children) => {
      headingIds.add(githubHeadingSlug(children));
      return children;
    },
  });
  return headingIds;
}

describe("documentation routing", () => {
  test("parses valid packaged Markdown link forms", () => {
    const links = markdownLinks(`
[inline](docs/inline.md)
[titled](docs/titled.md "title")
[![nested image](badge.svg)](LICENSE)
[reference][guide]
[collapsed][]
[shortcut]

[guide]: docs/reference.md
[collapsed]: docs/collapsed.md
[shortcut]: docs/shortcut.md
`);

    expect(links).toEqual([
      "docs/inline.md",
      "docs/titled.md",
      "LICENSE",
      "docs/reference.md",
      "docs/collapsed.md",
      "docs/shortcut.md",
    ]);
    expect(relativeMarkdownTargets("README.md")).toContain("LICENSE");
  });

  test("routes exactly four audiences and classifies every top-level docs Markdown once", () => {
    expect(existsSync(DOCS_ROUTER_PATH)).toBe(true);
    const router = readRepoFile(DOCS_ROUTER_PATH);
    const audiences = routerAudienceEntries(router);
    const expectedAudienceNames = Object.keys(ROUTER_AUDIENCE_TARGETS) as Array<
      keyof typeof ROUTER_AUDIENCE_TARGETS
    >;

    expect([...audiences.keys()]).toEqual(expectedAudienceNames);
    for (const audience of expectedAudienceNames) {
      const entries = audiences.get(audience) ?? [];
      expect(entries.map(({ target }) => target)).toEqual(
        [...ROUTER_AUDIENCE_TARGETS[audience]],
      );
      for (const { label, description } of entries) {
        expect(label.length).toBeGreaterThan(8);
        expect(description.length).toBeGreaterThan(12);
      }
    }

    const expectedDocs = [...visibleRepositoryFiles()]
      .filter((path) => /^docs\/[^/]+\.md$/.test(path) && path !== DOCS_ROUTER_PATH)
      .sort();
    const primaryDocs = [...audiences.values()].flatMap((entries) =>
      entries.map(({ target }) => posix.normalize(posix.join("docs", target.split("#", 1)[0] ?? "")))
        .filter((path) => /^docs\/[^/]+\.md$/.test(path))
    ).sort();

    expect(primaryDocs).toEqual(expectedDocs);
    expect(new Set(primaryDocs).size).toBe(primaryDocs.length);
    expect(router).not.toContain("```");
  });

  test("uses only real relative router targets and fragments", () => {
    expect(existsSync(DOCS_ROUTER_PATH)).toBe(true);
    const files = visibleRepositoryFiles();
    const links = markdownLinks(readRepoFile(DOCS_ROUTER_PATH));
    const references = relativeMarkdownReferences(DOCS_ROUTER_PATH);

    expect(links.length).toBeGreaterThan(16);
    for (const link of links) {
      expect(link).not.toStartWith("/");
      expect(link).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
    }
    for (const { target, fragment } of references) {
      expect(files).toContain(target);
      if (fragment !== "") {
        expect(markdownHeadingIds(target)).toContain(fragment);
      }
    }
  });

  test("keeps the root docs list to top user journeys plus the complete router", () => {
    const docsSection = markdownH2Section(readRepoFile("README.md"), "docs");
    expect(markdownLinks(docsSection)).toEqual([
      "docs/installation.md",
      "docs/first-session.md",
      "docs/phone-pwa-notifications.md",
      "docs/troubleshooting.md",
      DOCS_ROUTER_PATH,
    ]);
  });

  test("public security links target a real canonical installation heading", () => {
    expect(readRepoFile("site/index.html")).toContain(`href="${CANONICAL_SECURITY_URL}"`);
    expect(readRepoFile("site/llms-full.txt")).toContain(`Security model: ${CANONICAL_SECURITY_URL}`);

    const canonicalUrl = new URL(CANONICAL_SECURITY_URL);
    expect(canonicalUrl.hash).not.toBe("");
    expect(markdownHeadingIds("docs/installation.md")).toContain(canonicalUrl.hash.slice(1));
  });

  test("routes the physical-device Tailnet release gate to maintainer guidance", () => {
    const installation = readRepoFile("docs/installation.md");
    const contributing = readRepoFile("CONTRIBUTING.md");
    const matrixPath = "docs/tailnet-release-matrix.md";

    expect(installation).not.toContain("physical-device release matrix");
    expect(installation).not.toContain("Before a Tailnet release");
    expect(installation).toContain("wolfpack doctor");
    expect(relativeMarkdownTargets("docs/installation.md")).toContain("docs/troubleshooting.md");
    expect(relativeMarkdownTargets("docs/installation.md")).not.toContain(matrixPath);

    expect(contributing).toContain("Before a Tailnet release");
    expect(contributing).toContain("physical-device evidence is required");
    expect(contributing).toContain("automated checks do not substitute for it");
    expect(markdownLinks(contributing)).toContain(matrixPath);
    expect(relativeMarkdownTargets("CONTRIBUTING.md")).toContain(matrixPath);
    expect(readRepoFile(matrixPath).length).toBeGreaterThan(0);
  });

  test("the Tailnet matrix routes provenance and troubleshooting to tracked docs", () => {
    const matrixPath = "docs/tailnet-release-matrix.md";
    const matrix = readRepoFile(matrixPath);
    const link = matrix.match(/\[troubleshooting\]\((troubleshooting\.md#[^)]+)\)/)?.[1];

    expect(relativeMarkdownTargets(matrixPath)).toContain(
      "docs/multi-machine-control-room.md",
    );
    expect(link).toBeDefined();

    const fragment = link?.split("#", 2)[1] ?? "";
    expect(fragment).not.toBe("");
    expect(markdownHeadingIds("docs/troubleshooting.md")).toContain(fragment);
  });

  test("owns package membership, exclusions, and strict transitive Markdown closure", () => {
    const files = packedFiles();
    const markdownDocuments = [...files]
      .filter((file) => file.endsWith(".md") || file === "llms.txt");
    const missingTargets = markdownDocuments.flatMap((markdownPath) =>
      relativeMarkdownTargets(markdownPath)
        .filter((target) => !files.has(target))
        .map((target) => `${markdownPath} -> ${target}`),
    );
    const routerTargets = relativeMarkdownReferences(DOCS_ROUTER_PATH)
      .map(({ target }) => target)
      .filter((target) => target.endsWith(".md"));

    for (const requiredFile of [
      DOCS_ROUTER_PATH,
      "docs/installation.md",
      "docs/first-session.md",
      "docs/assets/wolfpack-desktop-dashboard.png",
      "docs/assets/wolfpack-mobile-sessions.png",
      "docs/troubleshooting.md",
      "docs/phone-pwa-notifications.md",
      "SUPPORT.md",
      "SECURITY.md",
      "llms.txt",
    ]) expect(files).toContain(requiredFile);
    for (const target of routerTargets) expect(files).toContain(target);
    expect(relativeMarkdownTargets("llms.txt")).toContain("docs/installation.md");
    expect([...files].filter((file) => file.startsWith(".github/"))).toEqual([]);
    expect(missingTargets).toEqual([]);
  });
});
