import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionsUsage } from "../../src/cli/extensions.ts";

test("update help and accepted flags describe the implemented source-and-trust contract", () => {
  expect(extensionsUsage()).toContain("update <absolute-directory|npm:name@version> --trust-browser-code [--skills pi]");
  const home = mkdtempSync(join(tmpdir(), "extensions-cli-"));
  try {
    // Exercise flag rejection through the real command, before source acquisition.
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { extensionsCommand } from ${JSON.stringify(new URL("../../src/cli/extensions.ts", import.meta.url).href)};
      process.exit(await extensionsCommand(["update", "/absolute/source", "--trust-browser-code", "--unexpected"]));
    `], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("update requires source and --trust-browser-code");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
