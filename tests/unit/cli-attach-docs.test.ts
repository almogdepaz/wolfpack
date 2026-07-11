import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import pkg from "../../package.json";

describe("cli attach docs", () => {
  test("document command usage, safety, and packaging", () => {
    const docs = readFileSync("docs/cli-attach.md", "utf-8");
    const readme = readFileSync("README.md", "utf-8");

    expect(docs).toContain("wolfpack attach [session]");
    expect(docs).toContain("Ctrl-]");
    expect(docs).toContain("--take-control");
    expect(docs).toContain("interactive TTYs");
    expect(docs).toContain("treat remote attach access like shell access");
    expect(readme).toContain("wolfpack attach [name]");
    expect(readme).toContain("docs/cli-attach.md");
    expect(pkg.files).toContain("docs/cli-attach.md");
  });
});
