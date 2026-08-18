import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

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
  readonly serviceRunning?: boolean;
  readonly serviceInstalled?: boolean;
  readonly providerCommands?: readonly string[];
  readonly setupOptions?: { readonly devDir?: string; readonly port?: number };
  readonly existingConfig?: { readonly devDir: string; readonly port: number; readonly tailscaleHostname?: string };
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
        execFileSync: (_file, args) => {
          if (args[0] === "status") return fixture.tailscale.selfStatus ?? JSON.stringify({ Self: { DNSName: fixture.tailscale.hostname + "." } });
          if (args[0] === "serve" && args[1] === "status") return JSON.stringify(fixture.tailscale.serveStatus);
          return "";
        },
      }));
    }
    if (fixture?.failsTailscaleInstallation || fixture?.tailscale) {
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
        if (!fixture?.failsTailscaleInstallation && !fixture?.tailscale) throw new Error("noninteractive setup must not prompt");
        if (prompt.includes("Install it now")) return "y";
        if (prompt.includes("doesn't exist")) return "y";
        if (prompt.includes("press Enter to retry")) return "skip";
        if (prompt.includes("Projects directory") || prompt.includes("Server port")) return "";
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
      await mock.module("./src/cli/service.js", () => ({
        ...service,
        isServiceInstalled: () => fixture?.serviceInstalled ?? false,
        isServiceRunning: () => fixture?.serviceRunning ?? false,
        refreshInstalledServerService: () => console.log("SERVICE_REFRESH=server-only"),
        serviceRestart: (options) => console.log("SERVICE_RESTART=" + JSON.stringify(options)),
      }));
    }

    const { setup } = await import("./src/cli/setup.ts");
    await setup({
      nonInteractive: !fixture?.failsTailscaleInstallation && !fixture?.tailscale,
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
  expect(result.stdout).not.toContain(
    "Scan the verified remote URL to open Wolfpack on your phone:",
  );
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

  test("persists and presents the verified remote URL when Tailscale is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-setup-flow-"));
    temporaryHomes.push(home);
    const configPath = join(home, ".wolfpack", "config.json");
    const hostname = "new.tailnet.ts.net";

    const result = runSetupFlow(home, { tailscale: {
      hostname,
      serveStatus: {
        Web: {
          [`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } } },
        },
      },
    } });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      devDir: join(home, "Dev"),
      port: 18790,
      tailscaleHostname: hostname,
    });
    expect(result.stdout).toContain(`Tailscale serving at https://${hostname}/`);
    expect(result.stdout).toContain(`Remote: https://${hostname}`);
    expect(result.stdout).toContain("Scan the verified remote URL to open Wolfpack on your phone:");
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
      serviceRunning: true,
    });

    expectSuccessfulSetup(result);
    expect(JSON.parse(readFileSync(join(home, ".wolfpack", "config.json"), "utf-8"))).toMatchObject({ port: 24444 });
    expect(result.stdout).toContain("SERVICE_REFRESH=server-only");
    expect(result.stdout).not.toContain("SERVICE_RESTART=");
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
    }, serviceRunning: true });

    expectSuccessfulSetup(result);
    expect(result.stdout).toContain("SERVICE_RESTART={\"broker\":false,\"skipBrokerSessionWarning\":true}");
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
