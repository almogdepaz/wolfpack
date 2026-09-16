import { describe, expect, test } from "bun:test";
import { resolveSelectedExtensionScope } from "../../public/extension-scope.ts";

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
  });
});
