import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");

describe("dynamic DOM security", () => {
  test("does not construct executable inline handlers", () => {
    expect(app).not.toMatch(/on(?:click|change)=["\']/i);
    expect(app).toContain('target.closest<HTMLElement>("[data-action]")');
  });

  test("keeps untrusted values in data/text contexts rather than JavaScript strings", () => {
    expect(app).toContain('data-action="open-session" data-session="${escAttr(s.name)}"');
    expect(app).toContain('data-action="agent-remove" data-command="${escAttr(c.cmd)}"');
  });
});
