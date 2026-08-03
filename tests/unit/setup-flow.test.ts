import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temporaryHomes: string[] = [];

interface TailscaleFixture {
  readonly hostname: string;
  readonly serveStatus: Record<string, unknown>;
  readonly previousHostname?: string;
}

interface SetupFlowFixture {
  readonly tailscale?: TailscaleFixture;
  readonly failsTailscaleInstallation?: boolean;
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
          if (args[0] === "status") return JSON.stringify({ Self: { DNSName: fixture.tailscale.hostname + "." } });
          if (args[0] === "serve" && args[1] === "status") return JSON.stringify(fixture.tailscale.serveStatus);
          return "";
        },
      }));
    }
    if (fixture?.failsTailscaleInstallation) {
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
    }
    await mock.module("./src/cli/config.js", () => ({
      ...config,
      CONFIG_PATH: configPath,
      WOLFPACK_DIR: join(home, ".wolfpack"),
      IS_MACOS: fixture?.failsTailscaleInstallation ?? false,
      IS_LINUX: false,
      ask: (() => {
        const answers = ["", "", "y", "", "n"];
        return () => fixture?.failsTailscaleInstallation
          ? (answers.shift() ?? "")
          : (() => { throw new Error("noninteractive setup must not prompt"); })();
      })(),
      loadConfig: () => fixture?.tailscale?.previousHostname
        ? { devDir: home, port: 18790, tailscaleHostname: fixture.tailscale.previousHostname }
        : null,
      saveConfig: (nextConfig) => {
        mkdirSync(join(home, ".wolfpack"), { recursive: true });
        writeFileSync(configPath, JSON.stringify(nextConfig));
      },
      remoteUrl: (nextConfig) => nextConfig.tailscaleHostname ? "https://" + nextConfig.tailscaleHostname : null,
      tailscaleBin: () => fixture?.tailscale ? "tailscale" : null,
    }));

    const { setup } = await import("./src/cli/setup.ts");
    await setup();
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
      devDir: join(home, "Dev"),
      port: 18790,
    });
    expect(result.stdout).toContain("Tailscale serve was not verified");
    expect(result.stdout).not.toContain("Remote: https://stale.tailnet.ts.net");
  });
});
