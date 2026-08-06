import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  readonly existingConfig?: { readonly devDir: string; readonly port: number; readonly tailscaleHostname?: string };
}

interface SetupFlowResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runSetupFlow(home: string, fixture?: SetupFlowFixture): SetupFlowResult {
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
    if (fixture?.serviceRunning) {
      const service = await import("./src/cli/service.ts");
      await mock.module("./src/cli/service.js", () => ({
        ...service,
        isServiceRunning: () => true,
        serviceRestart: (options) => console.log("SERVICE_RESTART=" + JSON.stringify(options)),
      }));
    }

    const { setup } = await import("./src/cli/setup.ts");
    await setup({ nonInteractive: !fixture?.failsTailscaleInstallation && !fixture?.tailscale });
  `;

  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
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

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("first-run setup", () => {
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
    expect(result.stdout).toContain("Local: http://localhost:18790/");
    expect(result.stdout).toContain("wolfpack doctor");
    expect(result.stdout).toContain("Create a session and run codex or claude.");
    expect(result.stdout).not.toContain("JWT Authentication");
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
      expect(result.stdout).not.toContain("Remote:");
    }
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
    expect(result.stdout).not.toContain("Remote: https://stale.tailnet.ts.net");
  });
});
