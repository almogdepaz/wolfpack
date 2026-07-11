import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("agent skills", () => {
  test("tailnet control skill documents safe opaque-context workflows", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");

    expect(skill).toContain("WOLFPACK_CURRENT_SESSION_ID");
    expect(skill).toContain("WOLFPACK_CURRENT_MACHINE_URL");
    expect(skill).toContain("Treat session selectors as opaque handles");
    expect(skill).toContain("Requires explicit user intent");
    expect(skill).toContain("Missing context handling");
    expect(skill).toContain("docs/broker-protocol.md");
    expect(skill).not.toContain("wss://host/ws/pty?session=<name>");
  });

  test("skill docs point at existing repo references", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");
    const references = [
      "README.md",
      "docs/broker-protocol.md",
      "skills/wolfpack-ralph/SKILL.md",
      "docs/troubleshooting.md",
    ];

    for (const reference of references) {
      expect(skill).toContain(reference);
      expect(existsSync(join(root, reference))).toBe(true);
    }
  });

  test("main package and readme include bundled skill distribution docs", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { files?: string[] };
    const readme = readRepoFile("README.md");
    const docs = readRepoFile("docs/agent-skills.md");

    expect(pkg.files).toContain("skills");
    expect(pkg.files).toContain("docs/agent-skills.md");
    expect(readme).toContain("docs/agent-skills.md");
    expect(docs).toContain("The npm package includes `skills/`");
    expect(docs).toContain("prefer symlinking each desired Wolfpack skill");
  });
});
