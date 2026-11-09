import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeTaskIntegration, checkPiTasksPackage, type ClaudeIntegrationDoctorOptions } from "../../src/cli/doctor-integrations.ts";
import type { CheckResult } from "../../src/cli/doctor.ts";
import { CLAUDE_INTEGRATION } from "../../src/claude-integration.ts";

const roots: string[] = [];

function agentWithPackages(packages: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-doctor-integrations-"));
  roots.push(root);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ packages }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor Pi Tasks package check", () => {
  test("warns about the legacy package with the migration commands", () => {
    const [result] = checkPiTasksPackage(agentWithPackages([{ source: "npm:@sgtbeatdown/pi-tasks@0.1.17" }]));
    expect(result).toMatchObject({ group: "Integrations", status: "warn" });
    expect(result?.detail).toContain("npm:@sgtbeatdown/pi-tasks@0.1.17");
    expect(result?.fixHint).toBe("pi remove npm:@sgtbeatdown/pi-tasks && pi install npm:@sgtbeatdown/wolfpack-tasks");
    expect(result?.fix).toBeUndefined();
  });

  test("reports nothing when the legacy package is absent", () => {
    expect(checkPiTasksPackage(agentWithPackages(["npm:@sgtbeatdown/wolfpack-tasks"]))).toEqual([]);
  });
});

describe("doctor Claude task integration checks", () => {
  const DROP_IN = `${JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "wolfpack-tasks" }] }, null, 2)}\n`;

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-doctor-claude-"));
    roots.push(root);
    return root;
  }

  function healthy(overrides: Partial<ClaudeIntegrationDoctorOptions> = {}): ClaudeIntegrationDoctorOptions {
    const root = tempRoot();
    const claudeConfigDirectory = join(root, "claude");
    mkdirSync(join(claudeConfigDirectory, "plugins"), { recursive: true });
    writeFileSync(join(claudeConfigDirectory, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "wolfpack-tasks@wolfpack-tasks": [{ scope: "user" }] },
    }));
    const dropInDirectory = join(root, "managed-settings.d");
    mkdirSync(dropInDirectory);
    writeFileSync(join(dropInDirectory, "wolfpack.json"), DROP_IN);
    const statusDirectory = join(root, "status");
    mkdirSync(statusDirectory);
    return {
      enabled: true,
      claudeDetected: true,
      run: () => ({ ok: true, stdout: "2.1.319 (Claude Code)\n" }),
      env: {},
      claudeConfigDirectory,
      dropInDirectory,
      statusDirectory,
      pidAlive: () => true,
      ...overrides,
    };
  }

  function byName(results: readonly CheckResult[], name: string): CheckResult | undefined {
    return results.find(result => result.name === name);
  }

  function writeStatus(directory: string, sessionId: string, fields: Record<string, unknown>): void {
    writeFileSync(join(directory, `${sessionId}.json`), JSON.stringify({
      version: 1, sessionId, sessionName: sessionId, pid: 4242, wake: "channel", protocolVersion: "2025-11-25", ...fields,
    }));
  }

  test("reports nothing without claude and one short line while the flag is off", () => {
    expect(checkClaudeTaskIntegration(healthy({ claudeDetected: false, enabled: false }))).toEqual([]);
    const off = checkClaudeTaskIntegration(healthy({ enabled: false, run: () => { throw new Error("must not run claude"); } }));
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ group: "Integrations", status: "pass" });
    expect(off[0]!.detail).toContain("off");
    expect(off[0]!.fixHint).toContain("wolfpack setup");
  });

  test("passes a healthy installation without fixes that run commands", () => {
    const results = checkClaudeTaskIntegration(healthy());
    expect(results.filter(result => result.status !== "pass")).toEqual([]);
    expect(results.map(result => result.name)).toEqual([
      "claude version",
      "claude provider",
      "claude plugin",
      "claude channel drop-in",
      "claude channel allowlist",
      "claude wake",
    ]);
    expect(results.every(result => result.fix === undefined)).toBe(true);
  });

  test("fails an old or unreadable claude version and a third-party provider", () => {
    expect(byName(checkClaudeTaskIntegration(healthy({ run: () => ({ ok: true, stdout: "2.1.318 (Claude Code)" }) })), "claude version")?.status).toBe("fail");
    expect(byName(checkClaudeTaskIntegration(healthy({ run: () => ({ ok: false, stdout: "" }) })), "claude version")?.status).toBe("fail");
    const provider = byName(checkClaudeTaskIntegration(healthy({ env: { CLAUDE_CODE_USE_VERTEX: "1" } })), "claude provider");
    expect(provider?.status).toBe("fail");
    expect(provider?.detail).toContain("CLAUDE_CODE_USE_VERTEX");
  });

  test("fails a missing plugin with the install command", () => {
    const options = healthy();
    rmSync(join(options.claudeConfigDirectory, "plugins", "installed_plugins.json"));
    const plugin = byName(checkClaudeTaskIntegration(options), "claude plugin");
    expect(plugin?.status).toBe("fail");
    expect(plugin?.fixHint).toContain("claude plugin install wolfpack-tasks@wolfpack-tasks");
  });

  test.each([
    ["missing", null],
    ["unparseable", "{"],
    ["channels disabled", JSON.stringify({ channelsEnabled: false, allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "wolfpack-tasks" }] })],
    ["without the plugin", JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [] })],
  ] as const)("fails a drop-in that is %s", (_name, content) => {
    const options = healthy();
    const path = join(options.dropInDirectory!, "wolfpack.json");
    if (content === null) rmSync(path);
    else writeFileSync(path, content);
    const dropIn = byName(checkClaudeTaskIntegration(options), "claude channel drop-in");
    expect(dropIn?.status).toBe("fail");
    expect(dropIn?.detail).toContain(path);
    expect(dropIn?.fixHint).toContain("wolfpack setup");
  });

  test("names other managed sources that set the allowlist or disable channels", () => {
    const options = healthy();
    const directory = options.dropInDirectory!;
    const managedSettings = join(directory, "..", "managed-settings.json");
    writeFileSync(managedSettings, JSON.stringify({ allowedChannelPlugins: [{ plugin: "other", marketplace: "corp" }] }));
    writeFileSync(join(directory, "90-corp.json"), JSON.stringify({ channelsEnabled: false }));
    writeFileSync(join(directory, "10-shared.json"), JSON.stringify({ allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "wolfpack-tasks" }] }));
    writeFileSync(join(directory, ".hidden.json"), JSON.stringify({ allowedChannelPlugins: [] }));
    writeFileSync(join(directory, "notes.txt"), "allowedChannelPlugins");
    const allowlist = byName(checkClaudeTaskIntegration(options), "claude channel allowlist");
    expect(allowlist?.status).toBe("warn");
    expect(allowlist?.detail).toContain(managedSettings);
    expect(allowlist?.detail).toContain("90-corp.json");
    expect(allowlist?.detail).not.toContain("10-shared.json");
    expect(allowlist?.detail).not.toContain(".hidden.json");
    expect(allowlist?.detail).not.toContain("notes.txt");
  });

  test("passes and names another managed source whose allowlist includes the channel", () => {
    const options = healthy();
    const shared = join(options.dropInDirectory!, "10-shared.json");
    writeFileSync(shared, JSON.stringify({ allowedChannelPlugins: [{ plugin: "wolfpack-tasks", marketplace: "wolfpack-tasks" }] }));
    const allowlist = byName(checkClaudeTaskIntegration(options), "claude channel allowlist");
    expect(allowlist?.status).toBe("pass");
    expect(allowlist?.detail).toContain(shared);
  });

  test("warns about each live session on fallback wake and ignores dead sessions", () => {
    const options = healthy({ pidAlive: (pid) => pid !== 9999 });
    const fallbackAt = Date.UTC(2026, 10, 9, 12, 0, 0);
    writeStatus(options.statusDirectory, "live-channel", { lastPointerAt: fallbackAt - 1_000 });
    writeStatus(options.statusDirectory, "live-fallback", { wake: "fallback", protocolVersion: "2025-06-18", fallbackAt });
    writeStatus(options.statusDirectory, "dead-fallback", { wake: "fallback", pid: 9999 });
    const results = checkClaudeTaskIntegration(options);
    const wake = results.filter(result => result.name === "claude wake");
    expect(wake).toHaveLength(1);
    expect(wake[0]?.status).toBe("warn");
    expect(wake[0]?.detail).toContain("live-fallback");
    expect(wake[0]?.detail).toContain("2025-06-18");
    expect(wake[0]?.detail).toContain(`fallback wake since ${new Date(fallbackAt).toISOString()}`);
    expect(wake[0]?.detail).not.toContain("dead-fallback");
    expect(wake[0]?.detail).toContain("1 on channel wake with pointer or inbox activity");
    expect(wake[0]?.fixHint).toContain(`--channels ${CLAUDE_INTEGRATION.channelSpec}`);
  });

  test("warns about a live session whose wake stalled after exhausted status checks", () => {
    const options = healthy();
    const stalledAt = Date.UTC(2026, 10, 9, 12, 5, 0);
    const reason = "wolfpack session status exited 1; fallback given up after 3 status checks";
    writeStatus(options.statusDirectory, "stalled", {
      lastPointerAt: stalledAt - 10_000, statusFailures: 3, wakeStalledAt: stalledAt, lastNudgeError: reason,
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain("stalled (stalled, pid 4242)");
    expect(wake?.detail).toContain(`channel wake stalled at ${new Date(stalledAt).toISOString()} after 3 status checks: ${reason}`);
    expect(wake?.fixHint).toContain("wolfpack session status");
    expect(wake?.fixHint).not.toContain("--channels");
  });

  test("names the wake mode of a stalled fallback session and adds the restart hint", () => {
    const options = healthy();
    const stalledAt = Date.UTC(2026, 10, 9, 12, 5, 0);
    writeStatus(options.statusDirectory, "stalled", {
      wake: "fallback", fallbackAt: stalledAt - 60_000, lastPointerAt: stalledAt - 10_000,
      statusFailures: 3, wakeStalledAt: stalledAt, lastNudgeError: "status unreadable; fallback given up after 3 status checks",
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain(`fallback wake stalled at ${new Date(stalledAt).toISOString()}`);
    expect(wake?.fixHint).toContain("wolfpack session status");
    expect(wake?.fixHint).toContain(`--channels ${CLAUDE_INTEGRATION.channelSpec}`);
  });

  test("warns about a live session with a nudge error and names the reason", () => {
    const options = healthy();
    writeStatus(options.statusDirectory, "nudged", {
      lastPointerAt: 1, statusFailures: 1, wakeStalledAt: null, lastNudgeError: "wolfpack session status exited 1",
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain("nudged (nudged, pid 4242)");
    expect(wake?.detail).toContain("last nudge error: wolfpack session status exited 1");
    expect(wake?.detail).toContain("1 failed status check");
  });

  test("a nudge error followed by a later inbox call is resolved", () => {
    const options = healthy();
    const nudgedAt = Date.UTC(2026, 10, 9, 12, 0, 0);
    writeStatus(options.statusDirectory, "recovered", {
      lastPointerAt: nudgedAt - 5_000, lastNudgeAt: nudgedAt, lastNudgeError: "session send exited 1", lastInboxAt: nudgedAt + 1_000,
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("pass");
    expect(wake?.detail).toBe("1 on channel wake with pointer or inbox activity");
  });

  test("a nudge error without a later inbox call is current", () => {
    const options = healthy();
    const nudgedAt = Date.UTC(2026, 10, 9, 12, 0, 0);
    writeStatus(options.statusDirectory, "failing", {
      lastPointerAt: nudgedAt - 5_000, lastNudgeAt: nudgedAt, lastNudgeError: "session send exited 1", lastInboxAt: nudgedAt - 60_000,
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain("failing (failing, pid 4242): last nudge error: session send exited 1");
  });

  test("a failed status check is current while its pointer has no later inbox call", () => {
    // Failed status checks set lastNudgeError without lastNudgeAt; the pointer they retry is lastPointerAt.
    const options = healthy();
    const inboxAt = Date.UTC(2026, 10, 9, 12, 0, 0);
    writeStatus(options.statusDirectory, "retrying", {
      lastInboxAt: inboxAt, lastPointerAt: inboxAt + 5_000, lastNudgeAt: null, statusFailures: 2, lastNudgeError: "wolfpack session status exited 1",
    });
    writeStatus(options.statusDirectory, "acknowledged", {
      lastPointerAt: inboxAt, lastInboxAt: inboxAt + 5_000, lastNudgeAt: null, statusFailures: 2, lastNudgeError: "wolfpack session status exited 1",
    });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain("retrying (retrying, pid 4242): last nudge error: wolfpack session status exited 1 (2 failed status checks)");
    expect(wake?.detail).not.toContain("acknowledged (");
    expect(wake?.detail).toContain("1 on channel wake with pointer or inbox activity");
  });

  test("counts channel pointer or inbox activity as evidence of delivery", () => {
    const options = healthy();
    writeStatus(options.statusDirectory, "pointer", { lastPointerAt: Date.now(), lastInboxAt: null, lastNudgeError: null, statusFailures: 0 });
    writeStatus(options.statusDirectory, "inbox", { lastPointerAt: null, lastInboxAt: Date.now() });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("pass");
    expect(wake?.detail).toBe("2 on channel wake with pointer or inbox activity");
  });

  test("reports a fresh channel session without activity as configured but unverified", () => {
    const options = healthy();
    writeStatus(options.statusDirectory, "fresh", { lastPointerAt: null, lastInboxAt: null, lastNudgeError: null, statusFailures: 0, wakeStalledAt: null });
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("pass");
    expect(wake?.detail).toBe("1 channel configured, unverified (no pointer or inbox activity yet)");
    expect(wake?.detail).not.toContain("with pointer or inbox activity");
  });

  test("reports unreadable status files instead of skipping them", () => {
    const options = healthy();
    writeStatus(options.statusDirectory, "fresh", {});
    const broken = join(options.statusDirectory, "broken.json");
    const partial = join(options.statusDirectory, "partial.json");
    writeFileSync(broken, "{");
    writeFileSync(partial, JSON.stringify({ sessionId: "partial" }));
    const wake = byName(checkClaudeTaskIntegration(options), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain(`unreadable status files: ${broken}, ${partial}`);
    expect(wake?.detail).toContain("1 channel configured, unverified");
    expect(wake?.fixHint).toContain(options.statusDirectory);
  });

  test("reports an unreadable status directory", () => {
    const root = tempRoot();
    const statusDirectory = join(root, "status-file");
    writeFileSync(statusDirectory, "not a directory");
    const wake = byName(checkClaudeTaskIntegration(healthy({ statusDirectory })), "claude wake");
    expect(wake?.status).toBe("warn");
    expect(wake?.detail).toContain(`cannot read ${statusDirectory}`);
  });
});
