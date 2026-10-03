import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ExtensionManifestError, qualifiedContributionId } from "../../src/extensions/manifest.ts";
import { ExtensionContributionGate } from "../../src/extensions/contribution-contract.ts";

describe("browser-safe extension contribution boundary", () => {
  test("preserves manifest error identity and contribution limits after metadata extraction", () => {
    expect(qualifiedContributionId("notes", "tab")).toBe("notes/tab");
    expect(() => qualifiedContributionId("bad/id", "tab")).toThrow(ExtensionManifestError);
    const gate = new ExtensionContributionGate("notes");
    for (let index = 0; index < 32; index++) gate.register("context-view", `tab-${index}`);
    expect(() => gate.register("context-view", "overflow")).toThrow("extension contribution limit exceeded (32)");
  });

  test("browser extension host bundle excludes Ajv and manifest parser code", async () => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../../public/extension-host.ts")],
      target: "browser",
      format: "esm",
      minify: false,
    });
    expect(result.success).toBe(true);
    const output = (await Promise.all(result.outputs.map(file => file.text()))).join("\n");
    expect(output).not.toContain("class Ajv");
    expect(output).not.toContain("invalid Wolfpack extension manifest");
  });
});
