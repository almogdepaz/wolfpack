import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const sample = (name: string, path: string) => join(root, "examples", "extensions", name, path);

test("Agent Context and Notes are independently packaged self-contained extension samples", () => {
  for (const [name, expectedId] of [["agent-context", "agent-context"], ["notes", "notes"]] as const) {
    for (const file of ["package.json", "README.md", "src/ui.ts", "dist/ui.js"]) expect(existsSync(sample(name, file))).toBe(true);
    const manifest = JSON.parse(readFileSync(sample(name, "package.json"), "utf8"));
    expect(manifest.wolfpack.id).toBe(expectedId);
    expect(manifest.wolfpack.ui).toBe("dist/ui.js");
    expect(readFileSync(sample(name, "dist/ui.js"), "utf8")).not.toMatch(/from\s+['"]/);
  }
  expect(existsSync(sample("agent-context", "schemas/context.schema.json"))).toBe(true);
  expect(existsSync(sample("agent-context", "skills/wolfpack-agent-context/SKILL.md"))).toBe(true);
  expect(existsSync(sample("agent-context", "skills/wolfpack-agent-context/references/context-format.md"))).toBe(true);
});

test("Agent Context view models keep hostile text inert and distinguish empty and failed data", async () => {
  const { contextViewModel } = await import("../../examples/extensions/agent-context/src/model.ts");
  expect(contextViewModel(null)).toMatchObject({ state: "empty", revision: 0 });
  expect(contextViewModel({ schemaVersion: 1, goal: "<img src=x onerror=alert(1)>", planItems: [], decisions: [], blockers: [], nextSteps: [] }, 3)).toMatchObject({ state: "ready", revision: 3, goal: "<img src=x onerror=alert(1)>" });
  expect(contextViewModel({ bad: true }, 4)).toMatchObject({ state: "error", revision: 4 });
});
