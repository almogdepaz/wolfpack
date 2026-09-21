import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileStaticDocumentSchema, validateDocumentPayload } from "../../src/extensions/document-contract.ts";

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
  const { acceptsRevision, contextViewModel } = await import("../../examples/extensions/agent-context/src/model.ts");
  expect(acceptsRevision(4, 3)).toBe(false);
  expect(acceptsRevision(4, 4)).toBe(true);
  expect(acceptsRevision(4, 5)).toBe(true);
  expect(contextViewModel(null)).toMatchObject({ state: "empty", revision: 0 });
  expect(contextViewModel({ schemaVersion: 1, goal: "<img src=x onerror=alert(1)>", planItems: [], decisions: [], blockers: [], nextSteps: [] }, 3)).toMatchObject({ state: "ready", revision: 3, goal: "<img src=x onerror=alert(1)>" });
  expect(contextViewModel({ bad: true }, 4)).toMatchObject({ state: "error", revision: 4 });
});

test("context schema accepts legacy text and structured headline/details without weakening bounds", async () => {
  const validator = compileStaticDocumentSchema(JSON.parse(readFileSync(sample("agent-context", "schemas/context.schema.json"), "utf8")));
  const { contextViewModel } = await import("../../examples/extensions/agent-context/src/model.ts");
  const legacy = { schemaVersion: 1, goal: "Existing goal", planItems: [{ id: "plan", text: "Existing plan", status: "pending" }], decisions: ["Existing decision"], blockers: [], nextSteps: ["Existing next step"] };
  expect(() => validateDocumentPayload(legacy, validator)).not.toThrow();
  const rich = { ...legacy, planItems: [{ ...legacy.planItems[0], details: "Supporting explanation" }], decisions: [{ id: "choice", text: "A concise headline", details: "Full rationale" }], blockers: [{ id: "missing-input", text: "Input needed", details: "Waiting for the named prerequisite" }], nextSteps: [{ id: "review", text: "Review", details: "Inspect the expanded content" }] };
  expect(() => validateDocumentPayload(rich, validator)).not.toThrow();
  expect(contextViewModel(rich, 2)).toMatchObject({ state: "ready", revision: 2, decisions: rich.decisions });
  expect(contextViewModel({ ...rich, state: "empty", revision: 999 }, 2)).toMatchObject({ state: "ready", revision: 2 });
  for (const invalid of [
    { ...rich, decisions: [{ id: "choice", text: "Missing details" }] },
    { ...rich, decisions: [{ id: "choice", text: "Headline", details: 42 }] },
    { ...rich, decisions: [{ id: "choice", text: "Headline", details: "" }] },
    { ...rich, decisions: [{ id: "choice", text: "x".repeat(241), details: "Details" }] },
    { ...rich, blockers: [{ id: "choice", text: "Headline", details: "x".repeat(16001) }] },
    { ...rich, nextSteps: [{ id: "choice", text: "Headline", details: "Details", executable: true }] },
    { ...rich, planItems: [{ ...rich.planItems[0], details: false }] },
  ]) expect(() => validateDocumentPayload(invalid, validator)).toThrow();
  expect(contextViewModel({ ...rich, decisions: [{ id: "choice", text: "Headline", details: 42 }] }, 3)).toMatchObject({ state: "error" });
  expect(contextViewModel({ ...rich, planItems: [{ ...rich.planItems[0], details: [] }] }, 3)).toMatchObject({ state: "error" });
});
