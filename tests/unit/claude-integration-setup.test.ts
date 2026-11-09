import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_INTEGRATION, claudeChannelDropInContent } from "../../src/claude-integration.ts";
import {
  claudeIntegrationDisableLines,
  claudeIntegrationDisclosureLines,
  claudeMarketplaceInstalled,
  claudePluginInstalled,
  claudeProviderOverride,
  claudeVersionMeetsMinimum,
  enableClaudeTaskIntegration,
  planClaudeIntegrationSetup,
  type ClaudeIntegrationEnableOptions,
  type ClaudeSetupRunner,
} from "../../src/cli/claude-integration-setup.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "wolfpack-claude-setup-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly interactive: boolean;
}

/** A fake runner: `sudo install` copies the source file so drop-in verification sees real content. */
function fakeRunner(options: {
  readonly version?: string;
  readonly fail?: (file: string, args: readonly string[]) => boolean;
} = {}): { readonly run: ClaudeSetupRunner; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: ClaudeSetupRunner = (file, args, runOptions) => {
    calls.push({ file, args: [...args], interactive: runOptions.interactive });
    if (options.fail?.(file, args)) return { ok: false, stdout: "" };
    if (file === "claude" && args[0] === "--version") return { ok: true, stdout: `${options.version ?? "2.1.319"} (Claude Code)\n` };
    if (file === "sudo" && args[0] === "mkdir") mkdirSync(args[2]!, { recursive: true });
    if (file === "sudo" && args[0] === "install") writeFileSync(args[4]!, readFileSync(args[3]!));
    return { ok: true, stdout: "" };
  };
  return { run, calls };
}

function claudeConfig(options: { readonly marketplace?: boolean; readonly plugin?: "user" | "project" } = {}): string {
  const directory = tempDir();
  mkdirSync(join(directory, "plugins"));
  if (options.marketplace) {
    writeFileSync(join(directory, "plugins", "known_marketplaces.json"), JSON.stringify({
      [CLAUDE_INTEGRATION.marketplace]: { source: { source: "github", repo: CLAUDE_INTEGRATION.marketplaceSource } },
    }));
  }
  if (options.plugin) {
    writeFileSync(join(directory, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { [CLAUDE_INTEGRATION.pluginSpec]: [{ scope: options.plugin, version: "0.1.0" }] },
    }));
  }
  return directory;
}

function enableOptions(overrides: Partial<ClaudeIntegrationEnableOptions> & { readonly run: ClaudeSetupRunner }): {
  readonly options: ClaudeIntegrationEnableOptions;
  readonly lines: string[];
  readonly confirmations: string[];
} {
  const lines: string[] = [];
  const confirmations: string[] = [];
  return {
    lines,
    confirmations,
    options: {
      env: {},
      claudeConfigDirectory: claudeConfig(),
      dropInDirectory: join(tempDir(), "managed-settings.d"),
      confirmDropIn: (path) => { confirmations.push(path); return true; },
      report: (line) => lines.push(line),
      ...overrides,
    },
  };
}

function commandLines(calls: readonly RecordedCall[]): string[] {
  return calls.map(call => [call.file, ...call.args].join(" "));
}

describe("claude task integration setup", () => {
  test("is offered only when claude is on PATH, as a prompt or non-interactive guidance", () => {
    const empty = tempDir();
    const withClaude = tempDir();
    writeFileSync(join(withClaude, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(withClaude, "claude"), 0o755);
    expect(planClaudeIntegrationSetup(empty, true)).toBe("hidden");
    expect(planClaudeIntegrationSetup(withClaude, true)).toBe("prompt");
    expect(planClaudeIntegrationSetup(withClaude, false)).toBe("guidance");
  });

  test("discloses the plugin install, the sudo drop-in and the allowlist precedence", () => {
    const text = claudeIntegrationDisclosureLines("/managed.d").join("\n");
    expect(text).toContain("claude plugin marketplace add almogdepaz/wolfpack-tasks");
    expect(text).toContain("claude plugin install wolfpack-tasks@wolfpack-tasks");
    expect(text).toContain("user scope");
    expect(text).toContain("sudo");
    expect(text).toContain("/managed.d/wolfpack.json");
    expect(text).toContain("replaces any lower-precedence allowlist");
    expect(text).toContain("another managed source can block it");
  });

  test("compares claude versions against the minimum and names a third-party provider override", () => {
    expect(claudeVersionMeetsMinimum("2.1.319 (Claude Code)")).toBe(true);
    expect(claudeVersionMeetsMinimum("2.2.0 (Claude Code)")).toBe(true);
    expect(claudeVersionMeetsMinimum("2.1.318 (Claude Code)")).toBe(false);
    expect(claudeVersionMeetsMinimum("not a version")).toBe(false);
    expect(claudeProviderOverride({})).toBeUndefined();
    expect(claudeProviderOverride({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBeUndefined();
    expect(claudeProviderOverride({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("CLAUDE_CODE_USE_BEDROCK");
    expect(claudeProviderOverride({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe("CLAUDE_CODE_USE_VERTEX");
  });

  test("reads claude's marketplace and user-scope plugin state read-only", () => {
    expect(claudeMarketplaceInstalled(claudeConfig())).toBe(false);
    expect(claudeMarketplaceInstalled(claudeConfig({ marketplace: true }))).toBe(true);
    expect(claudePluginInstalled(claudeConfig())).toBe(false);
    expect(claudePluginInstalled(claudeConfig({ plugin: "project" }))).toBe(false);
    expect(claudePluginInstalled(claudeConfig({ plugin: "user" }))).toBe(true);
    const malformed = claudeConfig();
    writeFileSync(join(malformed, "plugins", "installed_plugins.json"), "{");
    expect(claudePluginInstalled(malformed)).toBe(false);
  });

  test("runs every step in order with argv arrays and installs the exact drop-in content", () => {
    const runner = fakeRunner();
    const { options, confirmations } = enableOptions({ run: runner.run });
    const dropIn = join(options.dropInDirectory!, CLAUDE_INTEGRATION.dropInFileName);

    expect(enableClaudeTaskIntegration(options)).toEqual({ status: "enabled" });

    expect(commandLines(runner.calls).slice(0, 3)).toEqual([
      "claude --version",
      "claude plugin marketplace add almogdepaz/wolfpack-tasks",
      "claude plugin install wolfpack-tasks@wolfpack-tasks",
    ]);
    expect(runner.calls[3]).toMatchObject({ file: "sudo", args: ["mkdir", "-p", options.dropInDirectory] });
    expect(runner.calls[4]!.file).toBe("sudo");
    expect(runner.calls[4]!.args.slice(0, 3)).toEqual(["install", "-m", "0644"]);
    expect(runner.calls[4]!.args[4]).toBe(dropIn);
    expect(runner.calls).toHaveLength(5);
    expect(runner.calls[0]!.interactive).toBe(false);
    expect(runner.calls.slice(1).every(call => call.interactive)).toBe(true);
    expect(confirmations).toEqual([dropIn]);
    expect(readFileSync(dropIn, "utf8")).toBe(claudeChannelDropInContent());
  });

  test("re-runs skip satisfied steps without prompting or sudo", () => {
    const runner = fakeRunner();
    const { options, confirmations, lines } = enableOptions({
      run: runner.run,
      claudeConfigDirectory: claudeConfig({ marketplace: true, plugin: "user" }),
    });
    mkdirSync(options.dropInDirectory!, { recursive: true });
    writeFileSync(join(options.dropInDirectory!, CLAUDE_INTEGRATION.dropInFileName), claudeChannelDropInContent());

    expect(enableClaudeTaskIntegration(options)).toEqual({ status: "enabled" });
    expect(commandLines(runner.calls)).toEqual(["claude --version"]);
    expect(confirmations).toEqual([]);
    expect(lines.join("\n")).toContain("already");
  });

  test.each([
    ["an old claude", { version: "2.1.318" }, {}, "claude --version", undefined],
    ["a failed version command", { fail: (file: string, args: readonly string[]) => file === "claude" && args[0] === "--version" }, {}, "claude --version", "claude --version"],
    ["a Bedrock provider", {}, { CLAUDE_CODE_USE_BEDROCK: "1" }, "CLAUDE_CODE_USE_BEDROCK", undefined],
    ["a failed marketplace add", { fail: (_file: string, args: readonly string[]) => args[1] === "marketplace" }, {}, "marketplace", "claude plugin marketplace add almogdepaz/wolfpack-tasks"],
    ["a failed plugin install", { fail: (_file: string, args: readonly string[]) => args[1] === "install" }, {}, "install", "claude plugin install wolfpack-tasks@wolfpack-tasks"],
    ["a failed sudo install", { fail: (file: string, args: readonly string[]) => file === "sudo" && args[0] === "install" }, {}, "drop-in", "sudo install -m 0644"],
  ] as const)("stops at %s and reports the failed command and a retry hint", (_name, runnerOptions, env, reasonPart, failedCommandPrefix) => {
    const runner = fakeRunner(runnerOptions);
    const { options } = enableOptions({ run: runner.run, env });
    const result = enableClaudeTaskIntegration(options);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain(reasonPart);
    expect(result.retry.length).toBeGreaterThan(0);
    if (failedCommandPrefix === undefined) expect(result.failedCommand).toBeUndefined();
    else expect(result.failedCommand?.startsWith(failedCommandPrefix)).toBe(true);
    const failedIndex = runner.calls.findIndex(call => runnerOptions && "fail" in runnerOptions && runnerOptions.fail(call.file, call.args));
    if (failedIndex >= 0) expect(runner.calls).toHaveLength(failedIndex + 1);
  });

  test("stops without sudo when the drop-in confirmation is declined or the platform is unsupported", () => {
    const declined = fakeRunner();
    const { options } = enableOptions({ run: declined.run, confirmDropIn: () => false });
    const declinedResult = enableClaudeTaskIntegration(options);
    expect(declinedResult.status).toBe("failed");
    expect(declined.calls.some(call => call.file === "sudo")).toBe(false);

    const unsupported = fakeRunner();
    const result = enableClaudeTaskIntegration(enableOptions({ run: unsupported.run, dropInDirectory: undefined }).options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("platform");
    expect(unsupported.calls.some(call => call.file === "sudo")).toBe(false);
  });

  test("the disable lines print, and do not run, the sudo command that removes the drop-in", () => {
    const text = claudeIntegrationDisableLines("/Library/Application Support/ClaudeCode/managed-settings.d").join("\n");
    expect(text).toContain("sudo rm '/Library/Application Support/ClaudeCode/managed-settings.d/wolfpack.json'");
    expect(text).toContain("claude plugin uninstall wolfpack-tasks@wolfpack-tasks");
  });
});
