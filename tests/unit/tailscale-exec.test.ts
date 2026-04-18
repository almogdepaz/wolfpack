import { describe, test, expect } from "bun:test";
import { buildTailscaleStatusArgv } from "../../src/server/http.js";

// Regression: commit d6ffb69 "fixed" ISS-19 by dropping the login shell
// wrapper, which broke peer discovery under launchd for users with the macOS
// App Store Tailscale (the CLI needs session env to reach the GUI-hosted
// daemon; without it, stdout is a plaintext error that fails JSON.parse).
// Login shell invocation is load-bearing — this test locks it in.
describe("buildTailscaleStatusArgv", () => {
  test("invokes via /bin/sh login shell (required for App Store Tailscale under launchd)", () => {
    const { cmd, args } = buildTailscaleStatusArgv("/opt/homebrew/bin/tailscale");
    expect(cmd).toBe("/bin/sh");
    expect(args[0]).toBe("-l");
    expect(args[1]).toBe("-c");
  });

  test("passes status --json to tailscale", () => {
    const { args } = buildTailscaleStatusArgv("/opt/homebrew/bin/tailscale");
    expect(args[2]).toContain("status --json");
    expect(args[2]).toContain("/opt/homebrew/bin/tailscale");
  });

  test("quotes path with spaces (App Store bundle)", () => {
    const { args } = buildTailscaleStatusArgv("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(args[2]).toBe('"/Applications/Tailscale.app/Contents/MacOS/Tailscale" status --json');
  });
});
