import { describe, expect, test } from "bun:test";
import { ExtensionContributionGate } from "../../src/extensions/contribution-contract.ts";
import { ExtensionManifestError, parseExtensionPackageManifest, qualifiedContributionId } from "../../src/extensions/manifest.ts";

const valid = {
  name: "wolfpack-extension-agent-context", version: "0.1.0",
  wolfpack: { manifestVersion: 1, apiVersion: 1, id: "agent-context", ui: "dist/ui.js", skills: ["skills/wolfpack-agent-context"], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.schema.json" }] },
} as const;

describe("extension package manifest contract", () => {
  test("accepts static metadata without executing a bundle", () => {
    expect(parseExtensionPackageManifest(valid)).toEqual(valid);
    expect(qualifiedContributionId("agent-context", "context")).toBe("agent-context/context");
  });
  test("qualifies post-load registrations under the verified package identity", () => {
    const gate = new ExtensionContributionGate("agent-context");
    expect(gate.register("context-view", "context")).toEqual({ kind: "context-view", localId: "context", qualifiedId: "agent-context/context" });
    expect(() => gate.register("terminal-layout", "context")).toThrow("duplicate");
  });
  test("fails closed on unsupported versions, escaping paths, and duplicate documents", () => {
    for (const value of [
      { ...valid, wolfpack: { ...valid.wolfpack, apiVersion: 2 } },
      { ...valid, wolfpack: { ...valid.wolfpack, ui: "../ui.js" } },
      { ...valid, wolfpack: { ...valid.wolfpack, documents: [...valid.wolfpack.documents, valid.wolfpack.documents[0]] } },
    ]) expect(() => parseExtensionPackageManifest(value)).toThrow(ExtensionManifestError);
  });
});
