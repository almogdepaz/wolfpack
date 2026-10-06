import { afterEach, beforeEach, expect, test } from "bun:test";
import { extensionsCommand, extensionsUsage } from "../../src/cli/extensions.ts";
import { __setExtensionRuntimeForTests } from "../../src/extensions/runtime.ts";

const previousTest = process.env.WOLFPACK_TEST;
beforeEach(() => { process.env.WOLFPACK_TEST = "1"; });
afterEach(() => { __setExtensionRuntimeForTests(undefined); if (previousTest === undefined) delete process.env.WOLFPACK_TEST; else process.env.WOLFPACK_TEST = previousTest; });

test("update help and accepted flags describe the implemented source-and-trust contract", async () => {
  expect(extensionsUsage()).toContain("update <absolute-directory|npm:name@version> --trust-browser-code [--skills pi]");
  let installed = false;
  __setExtensionRuntimeForTests({ install: async () => { installed = true; return { installation: {}, skills: [] }; } } as never);
  expect(await extensionsCommand(["update", "/absolute/source", "--trust-browser-code", "--unexpected"])).toBe(1);
  expect(installed).toBe(false);
});
