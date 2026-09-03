/**
 * Interactive setup wizard.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { printQR } from "../qr.js";
import { print, bold, green, red, dim, yellow, WOLF } from "./formatting.js";
import {
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  ask,
  loadConfig,
  saveConfig,
  remoteUrl,
  tailscaleBin,
  type Config,
} from "./config.js";
import {
  isServiceInstalled,
  isServiceRunning,
  refreshInstalledServerService,
  serviceInstall,
  serviceRestart,
} from "./service.js";
import { createLogger } from "../log.js";
import { initializeProviderSettingsFile } from "../initial-provider-settings.js";
import { FIRST_SESSION_GUIDE_URL } from "../documentation-links.js";
import {
  detectInstalledProviderCommands,
  getProviderDisplayName,
} from "../provider-readiness.js";
import type { OpenableHarness } from "../agent-kind.js";
import {
  acceptsPiIntegrationInstall,
  installPiIntegration,
  piIntegrationDisclosureLines,
  planPiIntegrationSetup,
} from "./pi-integration.js";
import { configureTailscaleRemoteAccess, inspectTailscaleSelf } from "./tailscale-remote-setup.js";
import pkg from "../../package.json";

const log = createLogger("setup");

function printSetupCompletion(options: {
  readonly port: number;
  readonly remoteUrl: string | null;
  readonly serviceInstalled: boolean;
  readonly serviceRunning: boolean;
  readonly detectedProviders: readonly OpenableHarness[];
}): void {
  const localUrl = `http://localhost:${options.port}/`;
  const firstProvider = options.detectedProviders[0];

  print("");
  print(green("  Setup complete — next steps:"));
  print(`  Local: ${bold(localUrl)}`);
  if (options.remoteUrl) {
    print(`  Remote: ${bold(options.remoteUrl)}`);
    print("");
    print(dim("  Scan the verified remote URL to open Wolfpack on your phone:"));
    print("");
    printQR(options.remoteUrl);
  }
  const serviceNextStep = options.serviceRunning
    ? "  Service: running (check with 'wolfpack service status')."
    : options.serviceInstalled
      ? "  Service: installed but stopped (start with 'wolfpack service start')."
      : "  Start: 'wolfpack' now, or 'wolfpack service install' at login.";
  print(dim(serviceNextStep));
  print(dim("  Check: 'wolfpack doctor'"));
  print(dim(firstProvider
    ? `  Next: select Create your first session and choose ${getProviderDisplayName(firstProvider)}, or choose Shell.`
    : "  Next: select Create your first session and choose Shell. Add an agent later in Settings → Agents."));
  print(dim(`  First session: ${FIRST_SESSION_GUIDE_URL}`));
  print("");
}

function installPackages(pkgs: string[]) {
  if (IS_MACOS) {
    try {
      execSync("brew --version", { stdio: "ignore" });
    } catch { /* expected: homebrew not installed */
      print(red("  Homebrew is required to install dependencies."));
      print(dim("  Install from https://brew.sh"));
      return;
    }
    const brewPkgs = pkgs.filter((p) => p !== "tailscale");
    const brewCasks = pkgs.filter((p) => p === "tailscale");
    if (brewPkgs.length > 0) {
      print(`  Installing ${brewPkgs.join(", ")}...`);
      execSync(`brew install --quiet ${brewPkgs.join(" ")}`, { stdio: "inherit" });
    }
    if (brewCasks.length > 0) {
      print("  Installing Tailscale (GUI app)...");
      execSync("brew install --cask --quiet tailscale", { stdio: "inherit" });
    }
  } else if (IS_LINUX) {
    try {
      execSync("apt --version", { stdio: "ignore" });
    } catch { /* expected: apt not available on this system */
      print(red("  apt is required to install dependencies."));
      return;
    }
    const aptPkgs = pkgs.filter((p) => p !== "tailscale");
    if (aptPkgs.length > 0) {
      print(`  Installing ${aptPkgs.join(", ")}...`);
      execSync(`sudo apt update -qq && sudo apt install -y -qq ${aptPkgs.join(" ")}`, { stdio: "inherit" });
    }
    if (pkgs.includes("tailscale")) {
      print("  Installing Tailscale...");
      // Security note: curl-pipe-sh without hash verification. This is the official
      // Tailscale install pattern (https://tailscale.com/kb/1031/install-linux) and
      // only runs during interactive user-initiated setup, not unattended. No practical
      // alternative exists for cross-distro interactive CLI installation.
      execSync("curl -fsSL https://tailscale.com/install.sh | sudo sh", { stdio: "inherit" });
    }
  } else {
    print(red("  Unsupported platform. Please install manually: " + pkgs.join(", ")));
  }
}

function configureInteractiveTailscaleRemoteAccess(options: {
  readonly interactive: boolean;
  readonly hasTailscale: boolean;
  readonly binary: string | null;
  readonly port: number;
}): string | undefined {
  const binary = options.binary;
  if (!options.interactive || !options.hasTailscale || !binary) return undefined;

  const runTailscale = (args: readonly string[]): string => {
    const [file, fileArgs] = IS_LINUX
      ? ["sudo", [binary, ...args]]
      : [binary, [...args]];
    return execFileSync(file, fileArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const inspectSelf = () => {
    try { return inspectTailscaleSelf(runTailscale(["status", "--self", "--json"])); }
    catch { return { status: "unavailable" } as const; }
  };
  let self = inspectSelf();
  if (self.status !== "ready" && (self.status === "logged-out" || self.status === "unavailable")) {
    if (IS_MACOS) {
      print(dim("  Launching Tailscale.app for sign-in..."));
      try { execSync("open /Applications/Tailscale.app", { stdio: "ignore" }); } catch (e: unknown) {
        log.warn("setup: failed to launch Tailscale.app", { error: e instanceof Error ? e.message : String(e) });
      }
    } else if (IS_LINUX) {
      print(dim("  Run 'sudo tailscale up' in another terminal to sign in."));
    }
    while (self.status !== "ready" && options.interactive) {
      const retry = ask("  Sign in, then press Enter to retry (or type skip): ");
      if (retry.toLowerCase() === "skip") break;
      self = inspectSelf();
    }
  }
  if (self.status === "ready") {
    const configured = configureTailscaleRemoteAccess({
      binary,
      port: options.port,
      run: (_file, args) => runTailscale(args),
    });
    if (configured.status === "verified") {
      print(green(`  Tailscale serving at ${configured.origin}/`));
      return configured.hostname;
    }
    print(red("  Tailscale Serve could not be structurally verified; no phone QR will be shown."));
    print(dim(`  Retry: ${IS_LINUX ? "sudo " : ""}${binary} serve --bg ${options.port}`));
  } else if (self.status === "logged-out") {
    print(yellow("  Tailscale is not signed in; phone and remote access remain unavailable."));
  } else if (self.status === "malformed-status") {
    print(red("  Tailscale returned malformed identity data; remote access remains unavailable."));
  } else {
    print(yellow("  Tailscale is unavailable; phone and remote access remain unavailable."));
  }
  return undefined;
}

function reconcileSetupService(
  previousConfig: Config | null,
  config: Config,
  deferServiceRestart: boolean | undefined,
): { readonly serviceInstalled: boolean; readonly serviceRunning: boolean } {
  const serviceInstalled = isServiceInstalled();
  let serviceRunning = serviceInstalled && isServiceRunning();
  const descriptorSettingsChanged = previousConfig?.devDir !== config.devDir
    || previousConfig?.port !== config.port;
  const remotePolicyChanged = previousConfig?.tailscaleHostname !== config.tailscaleHostname;
  if (descriptorSettingsChanged && serviceInstalled) {
    refreshInstalledServerService({ reload: !deferServiceRestart });
    if (!deferServiceRestart) serviceRunning = isServiceRunning();
  } else if (remotePolicyChanged && serviceRunning && !deferServiceRestart) {
    if (!serviceRestart({ broker: false, skipBrokerSessionWarning: true })) {
      throw new Error("failed to restart server service after setup changes");
    }
    serviceRunning = isServiceRunning();
  }
  return { serviceInstalled, serviceRunning };
}

function handleOptionalPiIntegration(interactive: boolean): void {
  const piIntegrationMode = planPiIntegrationSetup(process.env.PATH, interactive);
  if (piIntegrationMode === "prompt") {
    print("");
    print(bold("  Optional Pi integration:"));
    for (const line of piIntegrationDisclosureLines()) {
      print(dim(line));
    }
    const installPi = ask("  Install Wolfpack's control skill and Pi Tasks? [y/N] ");
    if (acceptsPiIntegrationInstall(installPi)) {
      const installResult = installPiIntegration({ pathValue: process.env.PATH });
      if (installResult.status === "installed") {
        print(green("  Installed the Wolfpack control skill and Pi Tasks."));
        print(dim("  Start a fresh Pi session, or run /reload in an existing session."));
      } else if (installResult.status === "skill_exists") {
        print(red("  Pi integration stopped: Wolfpack's control skill already exists."));
        print(dim(`  Review the existing skill before removing or replacing ${installResult.skillPath}.`));
      } else if (installResult.status === "skill_write_failed") {
        print(red("  Pi integration stopped: could not install Wolfpack's control skill."));
        if (installResult.canRetry) {
          print(dim(`  Check write access to ${installResult.skillPath} and rerun 'wolfpack setup'.`));
        } else {
          print(dim(`  Wolfpack could not clean the partial skill at ${installResult.skillPath}; review and remove it before rerunning setup.`));
        }
      } else {
        print(red(`  Pi integration install stopped at ${installResult.failedSource}.`));
        print(dim(`  Retry: ${installResult.retryCommand}`));
        print(dim("  Wolfpack's control skill was installed; Pi Tasks remains unavailable until the retry succeeds."));
      }
    } else {
      print(dim("  Skipped optional Pi integration."));
    }
  } else if (piIntegrationMode === "guidance") {
    print("");
    print(dim("  Pi detected; non-interactive mode skipped the optional Pi integration."));
    print(dim("  Run 'wolfpack setup' interactively to install the control skill and Pi Tasks."));
  }
}

function installSetupService(options: {
  readonly serviceInstalled: boolean;
  readonly serviceRunning: boolean;
  readonly interactive: boolean;
  readonly deferServiceRestart: boolean | undefined;
}): { readonly serviceInstalled: boolean; readonly serviceRunning: boolean } {
  if (options.serviceInstalled) return options;
  if (options.deferServiceRestart) {
    print(dim("  Service activation deferred."));
    return options;
  }
  if (!options.interactive) {
    print(dim("  Non-interactive mode — skipping service install."));
    print(dim("  Run 'wolfpack service install' to start automatically on login."));
    return options;
  }
  const installService = ask("  Start wolfpack automatically on login? [Y/n] ");
  if (installService.toLowerCase() === "n") return options;
  try {
    serviceInstall();
    return { serviceInstalled: true, serviceRunning: true };
  } catch (e) {
    print(red(`  Service install failed: ${e}`));
    return options;
  }
}

export interface SetupOptions {
  readonly nonInteractive?: boolean;
  readonly deferServiceRestart?: boolean;
  readonly devDir?: string;
  readonly port?: number;
}

export async function setup(options: SetupOptions = {}) {
  print(dim(WOLF));
  print(bold("  WOLFPACK"));
  print(dim(`  ${pkg.description}`));
  print("");

  // Detect non-interactive shells (CI, piped stdin, redirected stdout) so
  // setup can apply deterministic local-only defaults without prompting.
  // process.stdin.isTTY is undefined when not a TTY — treat any non-true
  // value as non-interactive.
  const hasTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const interactive = hasTty && !options.nonInteractive;
  if (!interactive && !options.nonInteractive) {
    throw new Error("setup requires a TTY; pass --non-interactive explicitly for safe unattended setup");
  }
  if (options.nonInteractive) {
    print(yellow("  Explicit non-interactive setup."));
    print(dim("  Existing configuration is preserved unless an override is provided."));
    print("");
  }
  const previousConfig = loadConfig();

  print(bold("  Checking prerequisites...\n"));

  let tsBin = tailscaleBin();
  let hasTailscale = !!tsBin;
  if (hasTailscale) {
    print(`  ${green("✓")} Tailscale`);
  } else {
    print(`  ${red("✗")} Tailscale ${dim("(required for Wolfpack phone and remote access)")}`);
  }

  const detectedProviders = detectInstalledProviderCommands(process.env.PATH);
  print(dim(detectedProviders.length > 0
    ? `  Detected coding-agent CLIs: ${detectedProviders.join(", ")}`
    : "  No coding-agent CLIs detected; shell will be enabled."));
  print("");

  // ── Install missing Tailscale dependency ──
  if (!hasTailscale) {
    const installTs = interactive
      ? ask("  Tailscale provides private HTTPS phone and remote access. Install it now? [Y/n] ")
      : "n";
    if (installTs.toLowerCase() !== "n") {
      try {
        installPackages(["tailscale"]);
      } catch (e: unknown) {
        log.warn("setup: Tailscale installation failed", { error: e instanceof Error ? e.message : String(e) });
        print(red("  Tailscale installation failed; continuing with local-only access."));
      }
      tsBin = tailscaleBin();
      hasTailscale = !!tsBin;
    }
    if (!hasTailscale) {
      print(yellow("  Phone and remote access stay unavailable until Tailscale is installed and signed in."));
    }
    print("");
  }

  // Dev directory
  const defaultDev = previousConfig?.devDir ?? resolve(homedir(), "Dev");
  const rawDevDir = options.devDir ?? (interactive ? ask(`  Projects directory [${defaultDev}]: `) : "");
  const devDir = resolve(rawDevDir || defaultDev);

  const SYSTEM_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/sys", "/proc"];
  if (devDir !== defaultDev && SYSTEM_PREFIXES.some(p => devDir === p || devDir.startsWith(p + "/"))) {
    print(red(`  Refusing to use system directory: ${devDir}`));
    process.exit(1);
  }
  if (!devDir.startsWith(homedir())) {
    print(yellow(`  Warning: projects directory is outside your home folder.`));
  }

  if (!existsSync(devDir)) {
    const create = interactive ? ask(`  ${devDir} doesn't exist. Create it? (y/n) `) : "y";
    if (create.toLowerCase() === "y") {
      mkdirSync(devDir, { recursive: true });
      print(green(`  Created ${devDir}`));
    } else {
      print(red("  Aborted."));
      process.exit(1);
    }
  }

  // Port
  const defaultPort = previousConfig?.port ?? 18790;
  const portStr = options.port !== undefined ? String(options.port) : (interactive ? ask(`  Server port [${defaultPort}]: `) : "");
  const port = Math.max(1024, Math.min(65535, Number(portStr) || defaultPort));

  // Tailscale readiness is persisted only after `serve status --json` proves
  // this exact canonical HTTPS origin proxies to Wolfpack's loopback port.
  const verifiedRemoteHostname = configureInteractiveTailscaleRemoteAccess({
    interactive,
    hasTailscale,
    binary: tsBin,
    port,
  });

  const config: Config = {
    devDir,
    port,
    ...((verifiedRemoteHostname ?? (!interactive ? previousConfig?.tailscaleHostname : undefined)) && {
      tailscaleHostname: verifiedRemoteHostname ?? previousConfig?.tailscaleHostname,
    }),
  };
  saveConfig(config);
  // The plist/unit embeds config values, while the remote-origin policy is
  // loaded by the server. Both paths must preserve broker-owned PTYs.
  let { serviceInstalled, serviceRunning } = reconcileSetupService(
    previousConfig,
    config,
    options.deferServiceRestart,
  );

  initializeProviderSettingsFile({
    settingsPath: join(WOLFPACK_DIR, "bridge-settings.json"),
    pathValue: process.env.PATH,
  });

  handleOptionalPiIntegration(interactive);

  ({ serviceInstalled, serviceRunning } = installSetupService({
    serviceInstalled,
    serviceRunning,
    interactive,
    deferServiceRestart: options.deferServiceRestart,
  }));

  printSetupCompletion({
    port: config.port,
    remoteUrl: verifiedRemoteHostname ? remoteUrl(config) : null,
    serviceInstalled,
    serviceRunning,
    detectedProviders,
  });
}
