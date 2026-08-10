import { describe, expect, test } from "bun:test";
import {
  TAILSCALE_STATUS_CACHE_TTL_MS,
  TAILSCALE_STATUS_TIMEOUT_MS,
  buildTailscaleSelfStatusArgv,
  buildTailscaleStatusArgv,
  createTailscaleStatusCache,
  executeTailscaleStatus,
} from "../../src/server/http.js";

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

  test("uses the bounded self-only query for machine identity", () => {
    const { cmd, args } = buildTailscaleSelfStatusArgv("/opt/homebrew/bin/tailscale");
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual(["-l", "-c", '"/opt/homebrew/bin/tailscale" status --self --json']);
  });

  test("quotes path with spaces (App Store bundle)", () => {
    const { args } = buildTailscaleStatusArgv("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(args[2]).toBe('"/Applications/Tailscale.app/Contents/MacOS/Tailscale" status --json');
  });
});

describe("Tailscale status execution bounds", () => {
  test("coalesces concurrent status reads, reuses a short-lived result, and refreshes after TTL", async () => {
    let now = 0;
    let reads = 0;
    let resolveFirst: ((value: unknown) => void) | undefined;
    const cache = createTailscaleStatusCache(() => {
      reads += 1;
      return new Promise((resolve) => { resolveFirst = resolve; });
    }, () => now);

    const concurrent = [cache.read(), cache.read(), cache.read()];
    expect(reads).toBe(1);
    resolveFirst?.({ sequence: 1 });
    await expect(Promise.all(concurrent)).resolves.toEqual([{ sequence: 1 }, { sequence: 1 }, { sequence: 1 }]);

    await expect(cache.read()).resolves.toEqual({ sequence: 1 });
    expect(reads).toBe(1);

    now = TAILSCALE_STATUS_CACHE_TTL_MS;
    const refreshed = cache.read();
    expect(reads).toBe(2);
    resolveFirst?.({ sequence: 2 });
    await expect(refreshed).resolves.toEqual({ sequence: 2 });
  });

  test("does not retain a timed-out or failed status read", async () => {
    let reads = 0;
    const cache = createTailscaleStatusCache(async () => {
      reads += 1;
      if (reads === 1) throw new Error("status timed out");
      return { recovered: true };
    });

    await expect(cache.read()).rejects.toThrow("status timed out");
    await expect(cache.read()).resolves.toEqual({ recovered: true });
    expect(reads).toBe(2);
  });

  test("sets a finite timeout on the login-shell subprocess", async () => {
    let timeout: number | undefined;
    await expect(executeTailscaleStatus("/opt/homebrew/bin/tailscale", async (_file, _args, options) => {
      timeout = options?.timeout;
      return { stdout: '{"Self":{}}', stderr: "" };
    })).resolves.toEqual({ Self: {} });
    expect(timeout).toBe(TAILSCALE_STATUS_TIMEOUT_MS);
  });

  test("executes the self-only status command when requested", async () => {
    let command = "";
    await expect(executeTailscaleStatus("/opt/homebrew/bin/tailscale", async (_file, args) => {
      command = args[2] ?? "";
      return { stdout: '{"Self":{}}', stderr: "" };
    }, true)).resolves.toEqual({ Self: {} });
    expect(command).toContain("status --self --json");
  });
});
