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
