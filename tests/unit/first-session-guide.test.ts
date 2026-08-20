import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const GUIDE_PATH = "docs/first-session.md";
const CANONICAL_GUIDE_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/first-session.md";

function readRepoFile(path: string): string {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "";
}

function markdownStructure(markdown: string): {
  readonly headings: readonly string[];
  readonly images: ReadonlyMap<string, string>;
  readonly codeBlocks: readonly string[];
} {
  const headings: string[] = [];
  const images = new Map<string, string>();
  const codeBlocks: string[] = [];
  Bun.markdown.render(markdown, {
    heading: (children) => {
      headings.push(children);
      return children;
    },
    image: (children, { src }) => {
      images.set(src, children);
      return children;
    },
    code: (children) => {
      codeBlocks.push(children.trim());
      return children;
    },
  });
  return { headings, images, codeBlocks };
}

describe("canonical first-session guide", () => {
  test("routes README, website, and agent-readable website to the same guide", () => {
    expect(readRepoFile("README.md")).toContain("(docs/first-session.md)");
    expect(readRepoFile("site/index.html")).toContain(`href="${CANONICAL_GUIDE_URL}"`);
    expect(readRepoFile("site/llms-full.txt")).toContain(`First session: ${CANONICAL_GUIDE_URL}`);
  });

  test("walks the real browser checkpoints in order and bounds persistence", () => {
    const guide = readRepoFile(GUIDE_PATH);
    const structure = markdownStructure(guide);
    const expectedHeadings = [
      "1. open Wolfpack",
      "2. start a new session",
      "3. choose a project",
      "4. choose a session name and agent",
      "5. run a harmless command or task",
      "6. reopen the same session",
      "7. optional: reopen from your phone",
    ];

    expect(structure.headings).toEqual(["your first Wolfpack session", ...expectedHeadings]);
    for (const checkpoint of [
      "printed local URL",
      "**New session**",
      "machine's `+`",
      "**Open a folder**",
      "**Create a project**",
      "proposed session name",
      "enabled installed agent",
      "**Shell**",
      "Return to **Sessions**",
      "reopen the same session",
      "broker-owned PTY",
      "server upgrades and restarts",
      "explicitly stop or kill",
      "host reboot",
      "verified Tailnet URL",
      "verified QR code",
    ]) {
      expect(guide).toContain(checkpoint);
    }
    expect(structure.codeBlocks).toContain("pwd");
  });

  test("uses the locked desktop and phone evidence with useful captions", () => {
    const guide = readRepoFile(GUIDE_PATH);
    const images = markdownStructure(guide).images;

    expect(images.get("assets/wolfpack-desktop-dashboard.png")).toContain("desktop");
    expect(images.get("assets/wolfpack-mobile-sessions.png")).toContain("phone");
    expect(guide).toContain("Desktop checkpoint:");
    expect(guide).toContain("Phone checkpoint:");
  });

  test("exports one canonical runtime URL for setup and browser rendering", async () => {
    const { FIRST_SESSION_GUIDE_URL } = await import("../../src/documentation-links.ts");
    expect(FIRST_SESSION_GUIDE_URL).toBe(CANONICAL_GUIDE_URL);
  });
});
