import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployBundledPiSkills } from "../../src/extensions/pi-skill-deployment.ts";

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function root(): string { return mkdtempSync(join(tmpdir(), "wolfpack-pi-skills-")); }
const skill = (content = "---\nname: context\n---\n# Context\n") => ({ name: "wolfpack-agent-context", sourceDigest: digest(content), files: [{ path: "SKILL.md", content }] });

describe("bundled Pi skill deployment ownership", () => {
  test("writes only explicit static skills and refuses user collisions or modifications", () => {
    const directory = root();
    try {
      expect(deployBundledPiSkills({ skillsRoot: directory, extensionId: "agent-context", skills: [skill()] })).toEqual([{ name: "wolfpack-agent-context", status: "installed" }]);
      expect(readFileSync(join(directory, "wolfpack-agent-context", "SKILL.md"), "utf8")).toContain("Context");
      expect(deployBundledPiSkills({ skillsRoot: directory, extensionId: "agent-context", skills: [skill()] })).toEqual([{ name: "wolfpack-agent-context", status: "unchanged" }]);
      writeFileSync(join(directory, "wolfpack-agent-context", "SKILL.md"), "user edit");
      expect(deployBundledPiSkills({ skillsRoot: directory, extensionId: "agent-context", skills: [skill("new")] })[0]).toMatchObject({ status: "modified" });
      const other = join(directory, "unowned");
      mkdirSync(other); writeFileSync(join(other, "SKILL.md"), "user");
      expect(deployBundledPiSkills({ skillsRoot: directory, extensionId: "agent-context", skills: [{ ...skill(), name: "unowned" }] })[0]).toMatchObject({ status: "collision" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
