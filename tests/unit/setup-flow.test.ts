import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import type { Config } from "../../src/config.ts";

const root = process.cwd();
const temporaryHomes: string[] = [];

interface TailscaleFixture {
  readonly hostname?: string;
  readonly selfStatus?: string;
  readonly serveStatus: Record<string, unknown>;
  readonly previousHostname?: string;
}

interface SetupFlowFixture {
  readonly tailscale?: TailscaleFixture;
  readonly failsTailscaleInstallation?: boolean;
  readonly serviceRunning?: boolean | readonly boolean[];
  readonly serviceInstalled?: boolean;
  readonly installServiceAnswer?: string;
  readonly serviceRestartSucceeded?: boolean;
  readonly providerCommands?: readonly string[];
  readonly setupOptions?: {
    readonly devDir?: string;
    readonly port?: number;
    readonly deferServiceRestart?: boolean;
    readonly displayName?: string;
  };
  readonly claude?: {
    readonly interactive?: boolean;
    /** Prompt substring → answer. */
    readonly answers?: Readonly<Record<string, string>>;
    /** What the mocked enableClaudeTaskIntegration returns. */
    readonly enableResult?: Readonly<Record<string, unknown>>;
  };
  readonly existingConfig?: {
    readonly devDir: string;
    readonly port: number;
    readonly tailscaleHostname?: string;
    readonly displayName?: string;
    readonly claudeTaskIntegration?: boolean;
    readonly focus?: Config["focus"];
    readonly pinnedSessions?: Config["pinnedSessions"];
  };
}

interface SetupFlowResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function createProviderPath(home: string, commands: readonly string[]): string {
  const providerBin = join(home, "provider-bin");
  mkdirSync(providerBin, { recursive: true });
  for (const command of commands) {
    const executable = join(providerBin, command);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
  }
  return providerBin;
}

function runSetupFlow(home: string, fixture?: SetupFlowFixture): SetupFlowResult {
  const providerPath = createProviderPath(home, fixture?.providerCommands ?? []);
  const serializedFixture = JSON.stringify(fixture ?? null);
  const script = String.raw`
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";

    const home = process.env.HOME;
    const fixture = ${serializedFixture};
    const configPath = join(home, ".wolfpack", "config.json");
    const config = await import("./src/cli/config.ts");
    if (fixture?.tailscale || fixture?.failsTailscaleInstallation) {
      const childProcess = await import("node:child_process");
      await mock.module("node:child_process", () => ({
        ...childProcess,
        execSync: (command, options) => {
          if (fixture?.failsTailscaleInstallation && command === "brew --version") return "";
          if (fixture?.failsTailscaleInstallation && command.startsWith("brew install --cask")) {
            throw new Error("simulated Tailscale install failure");
          }
          return childProcess.execSync(command, options);
        },
        execFileSync: (file, args) => {
          if (fixture?.failsTailscaleInstallation && file === "brew" && args[0] === "--version") return "";
          if (fixture?.failsTailscaleInstallation && file === "brew" && args[0] === "install" && args.includes("tailscale")) {
            throw new Error("simulated Tailscale install failure");
          }
          if (args[0] === "status") return fixture.tailscale.selfStatus ?? JSON.stringify({ Self: { DNSName: fixture.tailscale.hostname + "." } });
          if (args[0] === "serve" && args[1] === "status") return JSON.stringify(fixture.tailscale.serveStatus);
          return "";
        },
      }));
    }
    if (fixture?.claude?.enableResult) {
      const claudeSetup = await import("./src/cli/claude-integration-setup.ts");
      await mock.module("./src/cli/claude-integration-setup.js", () => ({
        ...claudeSetup,
        enableClaudeTaskIntegration: (options) => {
          console.log("CLAUDE_ENABLE");
          options.confirmDropIn("/managed.d/wolfpack.json");
          return fixture.claude.enableResult;
        },
      }));
    }
    const interactiveFixture = Boolean(fixture?.failsTailscaleInstallation || fixture?.tailscale || fixture?.claude?.interactive);
    if (interactiveFixture) {
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
    }
    await mock.module("./src/cli/config.js", () => ({
      ...config,
      CONFIG_PATH: configPath,
      WOLFPACK_DIR: join(home, ".wolfpack"),
      IS_MACOS: fixture?.failsTailscaleInstallation ?? false,
      IS_LINUX: false,
      ask: (prompt) => {
        if (!interactiveFixture) throw new Error("noninteractive setup must not prompt");
        for (const [promptPart, answer] of Object.entries(fixture?.claude?.answers ?? {})) {
          if (prompt.includes(promptPart)) {
            console.log("PROMPT=" + prompt.trim());
            return answer;
          }
        }
        if (prompt.includes("Install it now")) return "y";
        if (prompt.includes("doesn't exist")) return "y";
        if (prompt.includes("press Enter to retry")) return "skip";
        if (prompt.includes("Projects directory") || prompt.includes("Server port")) return "";
        if (prompt.includes("Start wolfpack automatically on login")) {
          console.log("SERVICE_INSTALL_PROMPT");
          return fixture?.installServiceAnswer ?? "n";
        }
        return "n";
      },
      loadConfig: () => fixture?.existingConfig ?? (fixture?.tailscale?.previousHostname
        ? { devDir: home, port: 18790, tailscaleHostname: fixture.tailscale.previousHostname }
        : null),
      saveConfig: (nextConfig) => {
        mkdirSync(join(home, ".wolfpack"), { recursive: true });
        writeFileSync(configPath, JSON.stringify(nextConfig));
      },
      remoteUrl: (nextConfig) => nextConfig.tailscaleHostname ? "https://" + nextConfig.tailscaleHostname : null,
      tailscaleBin: () => fixture?.tailscale ? "tailscale" : null,
    }));
    if (fixture?.serviceRunning || fixture?.serviceInstalled) {
      const service = await import("./src/cli/service.ts");
      const runningStates = Array.isArray(fixture?.serviceRunning)
        ? fixture.serviceRunning
        : [fixture?.serviceRunning ?? false];
      let runningStateIndex = 0;
      await mock.module("./src/cli/service.js", () => ({
        ...service,
        isServiceInstalled: () => fixture?.serviceInstalled ?? false,
        isServiceRunning: () => runningStates[runningStateIndex++] ?? runningStates[runningStates.length - 1],
        refreshInstalledServerService: (options) => console.log(
          "SERVICE_REFRESH=" + (options?.reload === false ? "descriptor-only" : "server-only"),
        ),
        serviceInstall: () => console.log("SERVICE_INSTALL"),
        serviceRestart: (options) => {
          console.log("SERVICE_RESTART=" + JSON.stringify(options));
          return fixture?.serviceRestartSucceeded ?? true;
        },
      }));
    }

    const { setup } = await import("./src/cli/setup.ts");
    await setup({
      nonInteractive: !interactiveFixture,
      ...(fixture?.setupOptions ?? {}),
    });
  `;

  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      PATH: providerPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

function expectSuccessfulSetup(result: SetupFlowResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`setup failed:\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stderr).toBe("");
}

function expectLocalOnlyActivation(result: SetupFlowResult, port = 18790): void {
  expect(result.stdout).toContain(`Local: http://localhost:${port}/`);
  expect(result.stdout).not.toContain("Remote:");
  expect(result.stdout).not.toContain("Scan");
  expect(result.stdout).not.toMatch(/[▀▄█]/);
  expect(result.stdout).toContain("Open the local URL on this computer; Tailscale is not required for local access.");
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("first-run setup", () => {
  test("prints the canonical positioning in the actual setup banner", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);

    const result = runSetupFlow(home);

    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("WOLFPACK");
    expect(result.stdout).toContain(pkg.description);
    expect(result.stdout).not.toContain("AI Agent Bridge");
    expect(result.stdout).not.toContain("Deploy your pack. Command from anywhere.");
  });

  test("uses a local-only default in a clean noninteractive home", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const configPath = join(home, ".wolfpack", "config.json");

    const result = runSetupFlow(home);

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      devDir: join(home, "Dev"),
      port: 18790,
    });
    expect(result.stdout).toContain("Phone and remote access stay unavailable");
    expect(result.stdout).toContain("Setup complete — next steps:");
    expectLocalOnlyActivation(result);
    const startIndex = result.stdout.indexOf("Start: 'wolfpack' now");
    const doctorIndex = result.stdout.indexOf("Check: 'wolfpack doctor'");
    const nextAction = "Next: select Create your first session and choose Shell. Add an agent later in Settings → Agents.";
    const nextActionIndex = result.stdout.indexOf(nextAction);
    const guide = "First session: https://github.com/almogdepaz/wolfpack/blob/main/docs/first-session.md";
    const guideIndex = result.stdout.indexOf(guide);
    expect(startIndex).toBeGreaterThan(-1);
    expect(doctorIndex).toBeGreaterThan(startIndex);
    expect(nextActionIndex).toBeGreaterThan(doctorIndex);
    expect(guideIndex).toBeGreaterThan(nextActionIndex);
    expect(result.stdout.slice(nextActionIndex + nextAction.length, guideIndex).trim()).toBe("");
    expect(result.stdout).not.toContain("Create a session and run codex or claude.");
    expect(result.stdout).not.toContain("JWT Authentication");
  });

  test("recommends the first detected provider in canonical order by display name", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);

    const result = runSetupFlow(home, { providerCommands: ["gemini", "claude"] });

    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("Detected coding-agent CLIs: claude, gemini");
    expect(result.stdout).toContain(
      "Next: select Create your first session and choose Claude Code, or choose Shell.",
    );
    expect(result.stdout).not.toContain("choose Gemini CLI");
    expect(result.stdout).not.toContain("Create a session and run codex or claude.");
  });

  test("explicit noninteractive setup preserves every unspecified existing field", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const projectDir = join(home, "existing-projects");
    const result = runSetupFlow(home, { existingConfig: {
      devDir: projectDir,
      port: 24444,
      tailscaleHostname: "preserved.tailnet.ts.net",
    } });
    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual({
      devDir: projectDir,
      port: 24444,
      tailscaleHostname: "preserved.tailnet.ts.net",
    });
  });

  test("persists a display-name override and restarts only the running server", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      existingConfig: { devDir: home, port: 18790 },
      setupOptions: { displayName: "Studio Mac" },
      serviceInstalled: true,
      serviceRunning: true,
    });
    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual({
      devDir: home,
      port: 18790,
      displayName: "Studio Mac",
    });
    expect(result.stdout).toContain("SERVICE_RESTART={\"broker\":false,\"skipBrokerSessionWarning\":true}");
    expect(result.stdout).not.toContain("SERVICE_REFRESH=");
  });

  test("preserves an existing display name and clears it only on an explicit empty override", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const existingConfig = { devDir: home, port: 18790, displayName: "Studio Mac" };
    const preserved = runSetupFlow(home, { existingConfig, serviceInstalled: true, serviceRunning: true });
    expectSuccessfulSetup(preserved);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual(existingConfig);
    expect(preserved.stdout).not.toContain("SERVICE_RESTART=");

    const cleared = runSetupFlow(home, {
      existingConfig,
      setupOptions: { displayName: "" },
      serviceInstalled: true,
      serviceRunning: true,
    });
    expectSuccessfulSetup(cleared);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual({ devDir: home, port: 18790 });
    expect(cleared.stdout).toContain("SERVICE_RESTART={\"broker\":false,\"skipBrokerSessionWarning\":true}");
    expect(cleared.stdout).not.toContain("SERVICE_REFRESH=");
  });

  test("preserves the Claude task integration opt-in when it rewrites the config", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const existingConfig = { devDir: home, port: 18790, claudeTaskIntegration: true };
    const result = runSetupFlow(home, { existingConfig, serviceInstalled: true, serviceRunning: true });
    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual(existingConfig);
  });

  test.each([
    ["non-interactive", undefined, true, true],
    ["Claude enable", { interactive: true, answers: { "Enable the Claude task integration": "y", "Use sudo": "y" }, enableResult: { status: "enabled" } }, false, true],
    ["Claude disable", { interactive: true, answers: { "Disable it": "y" } }, true, false],
    ["Claude verification failure", { interactive: true, answers: { "Disable it": "n", "Use sudo": "y" }, enableResult: { status: "failed", reason: "fixture verification failure", retry: "wolfpack setup" } }, true, false],
    ["Claude opt-in declined", { interactive: true, answers: { "Enable the Claude task integration": "n" } }, false, false],
  ] as const)("preserves focus home and the assistant pin through %s setup", (_name, claude, enabledBefore, enabledAfter) => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const existingConfig: Config = {
      devDir: home, port: 19863,
      focus: { home: "remote-home" },
      pinnedSessions: [{ name: "assistant", cwd: home, command: ["pi"], harness: "pi" }],
      ...(enabledBefore && { claudeTaskIntegration: true }),
    };
    const result = runSetupFlow(home, {
      existingConfig, providerCommands: ["claude"], claude,
      serviceInstalled: true, serviceRunning: true,
    });
    expectSuccessfulSetup(result);
    const saved = JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"));
    expect(saved.focus).toEqual(existingConfig.focus);
    expect(saved.pinnedSessions).toEqual(existingConfig.pinnedSessions);
    expect(saved.claudeTaskIntegration).toBe(enabledAfter ? true : undefined);
  });

  test("non-interactive setup only points claude users at the interactive opt-in", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, { providerCommands: ["claude"] });
    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("Claude detected; non-interactive mode skipped the optional Claude task integration.");
    expect(result.stdout).not.toContain("CLAUDE_ENABLE");
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).not.toHaveProperty("claudeTaskIntegration");
  });

  test.each([
    ["persists the flag after every step succeeds", undefined, { "Enable the Claude task integration": "y", "Use sudo": "y" }, { status: "enabled" }, true],
    ["clears the flag when a verification re-run fails", true, { "Disable it": "n", "Use sudo": "y" }, {
      status: "failed",
      reason: "could not install the wolfpack-tasks@wolfpack-tasks plugin",
      failedCommand: "claude plugin install wolfpack-tasks@wolfpack-tasks",
      retry: "claude plugin install wolfpack-tasks@wolfpack-tasks, then wolfpack setup",
    }, false],
  ] as const)("interactive Claude opt-in %s", (_name, existingFlag, answers, enableResult, flagAfter) => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      providerCommands: ["claude"],
      claude: { interactive: true, answers, enableResult },
      existingConfig: { devDir: home, port: 18790, ...(existingFlag && { claudeTaskIntegration: true }) },
    });
    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("CLAUDE_ENABLE");
    expect(result.stdout).toContain("PROMPT=Use sudo to write /managed.d/wolfpack.json? [y/N]");
    const config = JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"));
    if (flagAfter) {
      expect(config.claudeTaskIntegration).toBe(true);
      expect(result.stdout).toContain("Enabled the Claude task integration.");
      expect(result.stdout).toContain("--channels plugin:wolfpack-tasks@wolfpack-tasks");
    } else {
      expect(config).not.toHaveProperty("claudeTaskIntegration");
      expect(result.stdout).toContain("Failed command: claude plugin install wolfpack-tasks@wolfpack-tasks");
      expect(result.stdout).toContain("Retry: claude plugin install wolfpack-tasks@wolfpack-tasks, then wolfpack setup");
      expect(result.stdout).toContain("The Claude task integration is off.");
    }
  });

  test.each([
    ["declining the offer changes nothing", undefined, { "Enable the Claude task integration": "n" }, "Skipped the optional Claude task integration."],
    ["disabling clears the flag and prints the sudo removal command", true, { "Disable it": "y" }, "sudo rm "],
  ] as const)("interactive Claude opt-in: %s", (_name, existingFlag, answers, expectedText) => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      providerCommands: ["claude"],
      claude: { interactive: true, answers, enableResult: { status: "enabled" } },
      existingConfig: { devDir: home, port: 18790, ...(existingFlag && { claudeTaskIntegration: true }) },
    });
    expectSuccessfulSetup(result);
    expect(result.stdout).not.toContain("CLAUDE_ENABLE");
    expect(result.stdout).toContain(expectedText);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).not.toHaveProperty("claudeTaskIntegration");
  });

  test.each([18790, 24444])("persists and presents both URLs below the verified remote QR with local port %p", (port) => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const configPath = join(home, ".wolfpack", "config.json");
    const hostname = "new.tailnet.ts.net";

    const result = runSetupFlow(home, { setupOptions: { port }, tailscale: {
      hostname,
      serveStatus: {
        Web: {
          [`${hostname}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } },
        },
      },
    } });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      devDir: join(home, "Dev"),
      port,
      tailscaleHostname: hostname,
    });
    expect(result.stdout).toContain(`Tailscale serving at https://${hostname}/`);
    expect(result.stdout).toContain(`Remote: https://${hostname}`);
    expect(result.stdout).toContain(`Local: http://localhost:${port}/`);
    expect(result.stdout).toContain("Scan the verified remote URL to open Wolfpack on your phone:");
    expect(result.stdout).toContain("You can use either URL on this computer; the Tailnet URL requires Tailscale.");
    expect(result.stdout).not.toContain("Both URLs work");
    const qrEnd = result.stdout.lastIndexOf("▀");
    expect(qrEnd).toBeGreaterThan(-1);
    expect(result.stdout.indexOf(`Remote: https://${hostname}`)).toBeGreaterThan(qrEnd);
    expect(result.stdout.indexOf(`Local: http://localhost:${port}/`)).toBeGreaterThan(result.stdout.indexOf("Remote:"));
    expect(result.stdout).not.toContain("Tailscale serve was not verified");
  });

  test("continues with local-only setup when Tailscale installation fails", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const configPath = join(home, ".wolfpack", "config.json");

    const result = runSetupFlow(home, { failsTailscaleInstallation: true });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      devDir: join(home, "Dev"),
      port: 18790,
    });
    expect(result.stdout).toContain("Tailscale installation failed; continuing with local-only access.");
    expect(result.stdout).toContain("Phone and remote access stay unavailable");
    expectLocalOnlyActivation(result);
  });

  test("keeps setup local-only for logged-out or malformed Tailscale identity states", () => {
    for (const [selfStatus, message] of [
      [JSON.stringify({ Self: {} }), "Tailscale is not signed in"],
      ["not json", "Tailscale returned malformed identity data"],
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
      temporaryHomes.push(home);
      const configPath = join(home, ".wolfpack", "config.json");
      const result = runSetupFlow(home, { tailscale: { selfStatus, serveStatus: {} } });

      expectSuccessfulSetup(result);
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ devDir: join(home, "Dev"), port: 18790 });
      expect(result.stdout).toContain(message);
      expectLocalOnlyActivation(result);
    }
  });

  test("refreshes an installed server descriptor when its port changes", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      existingConfig: { devDir: join(home, "Dev"), port: 18790 },
      setupOptions: { port: 24444 },
      serviceInstalled: true,
      serviceRunning: [false, true],
    });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toMatchObject({ port: 24444 });
    expect(result.stdout).toContain("SERVICE_REFRESH=server-only");
    expect(result.stdout).toContain("Service: running");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
  });

  test("defers descriptor activation during installer-managed setup", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      existingConfig: { devDir: join(home, "Dev"), port: 18790 },
      setupOptions: { port: 25555, deferServiceRestart: true },
      serviceInstalled: true,
      serviceRunning: true,
    });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toMatchObject({ port: 25555 });
    expect(result.stdout).toContain("SERVICE_REFRESH=descriptor-only");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
  });

  test("preserves an existing stopped login service without reinstalling it", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const hostname = "existing.tailnet.ts.net";
    const result = runSetupFlow(home, {
      tailscale: {
        hostname,
        serveStatus: { Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } } } },
      },
      existingConfig: { devDir: home, port: 18790, tailscaleHostname: hostname },
      serviceInstalled: true,
      serviceRunning: false,
      installServiceAnswer: "y",
    });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toEqual({
      devDir: home,
      port: 18790,
      tailscaleHostname: hostname,
    });
    const behaviorLog = result.stdout.split("\n");
    expect(behaviorLog).not.toContain("SERVICE_INSTALL_PROMPT");
    expect(behaviorLog).not.toContain("SERVICE_INSTALL");
    expect(result.stdout).not.toContain("SERVICE_REFRESH=");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
    expect(result.stdout).toContain("Service: installed but stopped");
    expect(result.stdout).not.toContain("Service: running");
  });

  test("does not refresh an installed descriptor when embedded settings are unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const result = runSetupFlow(home, {
      existingConfig: { devDir: join(home, "Dev"), port: 18790 },
      serviceInstalled: true,
      serviceRunning: true,
    });

    expectSuccessfulSetup(result);
    expect(result.stdout).not.toContain("SERVICE_REFRESH=");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
  });

  test("refreshes only the running server after verified remote readiness changes", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const hostname = "new.tailnet.ts.net";
    const result = runSetupFlow(home, { tailscale: {
      hostname,
      previousHostname: "stale.tailnet.ts.net",
      serveStatus: { Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } } } },
    }, serviceInstalled: true, serviceRunning: [true, false] });

    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("SERVICE_RESTART={\"broker\":false,\"skipBrokerSessionWarning\":true}");
    expect(result.stdout).toContain("Service: installed but stopped");
    expect(result.stdout).not.toContain("Service: running");
  });

  test("defers remote-policy restart during installer-managed setup", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const hostname = "deferred.tailnet.ts.net";
    const result = runSetupFlow(home, {
      tailscale: {
        hostname,
        previousHostname: "stale.tailnet.ts.net",
        serveStatus: { Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } } } },
      },
      serviceInstalled: true,
      serviceRunning: true,
      setupOptions: { deferServiceRestart: true },
    });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toMatchObject({
      tailscaleHostname: hostname,
    });
    expect(result.stdout).not.toContain("SERVICE_REFRESH=");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
  });

  test("does not offer service activation while restart deferral is active", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const hostname = "deferred-clean.tailnet.ts.net";
    const result = runSetupFlow(home, {
      tailscale: {
        hostname,
        serveStatus: { Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } } } },
      },
      setupOptions: { deferServiceRestart: true },
    });

    expectSuccessfulSetup(result);
    expect(result.stdout.split("\n")).not.toContain("SERVICE_INSTALL_PROMPT");
  });

  test("fails direct setup when its required server restart fails", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const hostname = "failed-restart.tailnet.ts.net";
    const result = runSetupFlow(home, {
      tailscale: {
        hostname,
        previousHostname: "stale.tailnet.ts.net",
        serveStatus: { Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } } } },
      },
      serviceInstalled: true,
      serviceRunning: true,
      serviceRestartSucceeded: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toMatchObject({
      tailscaleHostname: hostname,
    });
    expect(result.stdout).toContain("SERVICE_RESTART={\"broker\":false,\"skipBrokerSessionWarning\":true}");
    expect(result.stdout).not.toContain("Setup complete");
  });

  test("does not retain an unverified remote URL from an earlier setup", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const configPath = join(home, ".wolfpack", "config.json");

    const result = runSetupFlow(home, { tailscale: {
      hostname: "new.tailnet.ts.net",
      serveStatus: { Web: {} },
      previousHostname: "stale.tailnet.ts.net",
    } });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      devDir: home,
      port: 18790,
    });
    expect(result.stdout).toContain("Tailscale Serve could not be structurally verified");
    expectLocalOnlyActivation(result);
  });
});
