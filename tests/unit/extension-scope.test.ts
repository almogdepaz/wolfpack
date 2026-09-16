import { describe, expect, test } from "bun:test";
import { resolveSelectedExtensionScope, resolveWorkspaceExtensionScope } from "../../public/extension-scope.ts";

const sessionId = "22222222-2222-4222-8222-222222222222";

describe("selected extension scope", () => {
  test("uses only the selected terminal exact UUID and rejects remote transport", () => {
    expect(resolveSelectedExtensionScope({ sessionId, machine: "" }, "local-machine"))
      .toEqual({ sessionId });
    expect(resolveSelectedExtensionScope({ sessionId, machine: "local-machine" }, "local-machine"))
      .toEqual({ sessionId });
    expect(resolveSelectedExtensionScope({ sessionId, machine: "remote-machine" }, "local-machine"))
      .toEqual({ sessionId: null, unavailable: "Extension context is unavailable for a terminal served by another machine." });
  });

  test("does not turn a name/project-like fallback into an extension scope", () => {
    expect(resolveSelectedExtensionScope({ sessionId: null, machine: "" }, "local-machine")).toBeNull();
    expect(resolveSelectedExtensionScope({ sessionId: "session-name", machine: "" }, "local-machine")).toBeNull();
  });

  test("an inactive workspace has no extension scope even if a prior terminal target remains", () => {
    expect(resolveWorkspaceExtensionScope({
      workspaceActive: false,
      activeSurface: "single",
      singleTerminal: { sessionId, machine: "" },
    } as Parameters<typeof resolveWorkspaceExtensionScope>[0], "local-machine")).toBeNull();
  });

  test("resolves single, manual-grid, delegation-grid, missing, and remote transitions from the active surface", () => {
    const second = "33333333-3333-4333-8333-333333333333";
    const selected = (activeSurface: "single" | "manual-grid" | "delegation-grid", selectedGridPane?: { sessionId: string | null | undefined; machine: string | null | undefined }, singleTerminal = { sessionId, machine: "" }) => resolveWorkspaceExtensionScope({
      workspaceActive: true,
      activeSurface,
      selectedGridPane,
      singleTerminal,
    }, "local-machine");
    expect(selected("single")).toEqual({ sessionId });
    expect(selected("single", undefined, { sessionId: second, machine: "" })).toEqual({ sessionId: second });
    expect(selected("manual-grid", { sessionId, machine: "" })).toEqual({ sessionId });
    expect(selected("manual-grid", { sessionId: second, machine: "" })).toEqual({ sessionId: second });
    expect(selected("delegation-grid", { sessionId: second, machine: "" })).toEqual({ sessionId: second });
    expect(selected("manual-grid", undefined)).toBeNull();
    expect(selected("delegation-grid", { sessionId: "missing", machine: "" })).toBeNull();
    expect(selected("single", undefined, { sessionId, machine: "remote-machine" })).toEqual({ sessionId: null, unavailable: "Extension context is unavailable for a terminal served by another machine." });
  });

  test("active grid authority never falls back to the prior single-terminal UUID", () => {
    expect(resolveWorkspaceExtensionScope({
      activeSurface: "manual-grid",
      selectedGridPane: { sessionId: null, machine: "" },
      singleTerminal: { sessionId, machine: "" },
    }, "local-machine")).toBeNull();
    expect(resolveWorkspaceExtensionScope({
      activeSurface: "delegation-grid",
      selectedGridPane: undefined,
      singleTerminal: { sessionId, machine: "" },
    }, "local-machine")).toBeNull();
  });
});
