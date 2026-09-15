import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionContributionGate } from "../../src/extensions/contribution-contract.ts";
import { ExtensionManifestError, parseExtensionPackageManifest } from "../../src/extensions/manifest.ts";
import { ExtensionPackageError, fetchExactNpmPackage, parseExactNpmSpecifier } from "../../src/extensions/package-security.ts";
import { equalGridLayout, leadStackLayout, verticalStackLayout, validateTerminalLayout, LayoutValidationError, type LayoutContext, type TerminalLayout } from "../../src/extensions/layout-contract.ts";

const metadata = (version: string, id = "example") => ({
  name: `wolfpack-extension-${id}`, version,
  wolfpack: { manifestVersion: 1, apiVersion: 1, id, ui: "dist/ui.js", skills: [], documents: [] },
});

describe("canonical package versions and independent contributions", () => {
  test.each(["v1.2.3", "01.0.0", "1.0.0-01", "1.0.0-..", "=1.2.3", "1.2.3 ", " 1.2.3", "1.2.3+abc..x"])("rejects noncanonical/invalid SemVer %s in npm AND manifest", (version) => {
    expect(() => parseExtensionPackageManifest(metadata(version))).toThrow(ExtensionManifestError);
    expect(() => parseExactNpmSpecifier(`npm:example@${version}`)).toThrow(ExtensionPackageError);
  });
  test.each(["1.2.3", "0.0.0", "1.2.3-alpha.1", "1.2.3+build.001", "1.2.3-rc.1+build.001"])("preserves valid exact SemVer including build metadata: %s", (version) => {
    expect(parseExtensionPackageManifest(metadata(version)).version).toBe(version);
    expect(parseExactNpmSpecifier(`npm:example@${version}`).version).toBe(version);
  });
  test("missing SRI retains actionable INTEGRITY_MISMATCH classification", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-missing-sri-"));
    try {
      const mock = ((_command: string, args: readonly string[]) => args[0] === "--version" ? "10.9.8" : JSON.stringify([{ filename: "package.tgz" }])) as Parameters<typeof fetchExactNpmPackage>[2];
      let caught: unknown;
      try { fetchExactNpmPackage("npm:example@1.0.0", root, mock); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ExtensionPackageError);
      expect((caught as ExtensionPackageError).code).toBe("INTEGRITY_MISMATCH");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("tab-only and layout-only packages register independently under their package identities", () => {
    const tabPackage = parseExtensionPackageManifest(metadata("1.0.0", "tabs-only"));
    const layoutPackage = parseExtensionPackageManifest(metadata("1.0.0", "layouts-only"));
    const tabs = new ExtensionContributionGate(tabPackage.wolfpack.id);
    const layouts = new ExtensionContributionGate(layoutPackage.wolfpack.id);
    tabs.register("context-view", "main");
    layouts.register("terminal-layout", "main");
    expect(tabs.entries()).toEqual([{ kind: "context-view", localId: "main", qualifiedId: "tabs-only/main" }]);
    expect(layouts.entries()).toEqual([{ kind: "terminal-layout", localId: "main", qualifiedId: "layouts-only/main" }]);
    expect(() => tabs.register("terminal-layout", "main")).toThrow("duplicate");
    expect(layouts.entries()).toHaveLength(1);
  });
  test("runtime registration rejects unknown contribution kinds", () => {
    const gate = new ExtensionContributionGate("example");
    expect(() => gate.register("backend-plugin" as "context-view", "bad")).toThrow();
    expect(gate.entries()).toEqual([]);
  });
});

const panes = [{ id: "one" }];
const layout: TerminalLayout = { version: 1, rows: [{ size: 1 }], columns: [{ size: 1 }], placements: [{ paneId: "one", row: 0, column: 0 }] };
describe("runtime geometry validation", () => {
  test.each([null, undefined, 1, "row", [], {}].map((value) => [value]))("malformed track is typed: %j", (track) => {
    expect(() => validateTerminalLayout({ ...layout, rows: [track] }, panes)).toThrow(LayoutValidationError);
  });
  test.each([null, undefined, 1, "pane", []].map((value) => [value]))("malformed placement is typed: %j", (placement) => {
    expect(() => validateTerminalLayout({ ...layout, placements: [placement] }, panes)).toThrow(LayoutValidationError);
  });
  test.each([null, undefined, {}, [null], [{ id: null }], [{ id: "" }], [{ id: "x".repeat(257) }]].map((value) => [value]))("malformed host panes are typed: %j", (input) => {
    expect(() => validateTerminalLayout(layout, input)).toThrow(LayoutValidationError);
  });
  test("sparse track and host-pane arrays cannot bypass element validation", () => {
    expect(() => validateTerminalLayout({ ...layout, rows: new Array(1) }, panes)).toThrow(LayoutValidationError);
    expect(() => validateTerminalLayout(layout, new Array(1))).toThrow(LayoutValidationError);
  });
  test("null spans are not silently converted to the default span", () => {
    expect(() => validateTerminalLayout({ ...layout, placements: [{ ...layout.placements[0], rowSpan: null }] }, panes)).toThrow(LayoutValidationError);
  });
  test.each([equalGridLayout, leadStackLayout, verticalStackLayout])("built-in recipe handles empty, maximum and excessive pane counts", (arrange) => {
    const context = (count: number): LayoutContext => ({ panes: Array.from({ length: count }, (_value, index) => ({ id: `pane-${index}` })), selectedPaneId: "pane-11", viewport: { width: 1200, height: 800 } });
    expect(arrange(context(0)).placements).toEqual([]);
    expect(arrange(context(12)).placements).toHaveLength(12);
    expect(() => arrange(context(13))).toThrow(LayoutValidationError);
    expect(() => arrange(null as unknown as LayoutContext)).toThrow(LayoutValidationError);
    expect(() => arrange({ panes: [null] } as unknown as LayoutContext)).toThrow(LayoutValidationError);
  });
  test("selected lead is preserved at the advertised 12-pane cap", () => {
    const context: LayoutContext = { panes: Array.from({ length: 12 }, (_value, index) => ({ id: `pane-${index}` })), selectedPaneId: "pane-11", viewport: { width: 1200, height: 800 } };
    expect(leadStackLayout(context).placements[0]).toMatchObject({ paneId: "pane-11", row: 0, column: 0, rowSpan: 11 });
  });
  test("returns detached geometry, not mutable plugin-owned references", () => {
    const input = { version: 1 as const, rows: [{ size: 1 }], columns: [{ size: 1 }], placements: [{ paneId: "one", row: 0, column: 0 }] };
    const result = validateTerminalLayout(input, panes);
    input.rows[0]!.size = -1;
    input.placements[0]!.row = 999;
    expect(result.rows[0]!.size).toBe(1);
    expect(result.placements[0]!.row).toBe(0);
  });
});
