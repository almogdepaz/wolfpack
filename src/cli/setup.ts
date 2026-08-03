/**
 * Interactive setup wizard.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { printQR } from "../qr.js";
import { print, bold, green, red, dim, yellow, WOLF } from "./formatting.js";
import {
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  ask,
  saveConfig,
  remoteUrl,
  tailscaleBin,
  type Config,
} from "./config.js";
import { serviceInstall } from "./service.js";
import { createLogger } from "../log.js";
import { initializeProviderSettingsFile } from "../initial-provider-settings.js";
import { detectInstalledProviderCommands } from "../provider-readiness.js";
import {
  acceptsPiIntegrationInstall,
  installPiIntegration,
  piIntegrationDisclosureLines,
  planPiIntegrationSetup,
} from "./pi-integration.js";
import { configureTailscaleRemoteAccess, parseTailscaleHostname } from "./tailscale-remote-setup.js";

const log = createLogger("setup");

function check(name: string, cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    print(`  ${green("✓")} ${name}`);
    return true;
  } catch { /* expected: prerequisite not installed */
    print(`  ${red("✗")} ${name}`);
    return false;
  }
}

function printSetupCompletion(options: {
  readonly port: number;
  readonly remoteUrl: string | null;
  readonly serviceInstalled: boolean;
}): void {
  const localUrl = `http://localhost:${options.port}/`;

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
  print(options.serviceInstalled
    ? dim("  Service: running (check with 'wolfpack service status').")
    : dim("  Start: 'wolfpack' now, or 'wolfpack service install' at login."));
  print(dim("  Check: 'wolfpack doctor'"));
  print(dim("  Create a session and run codex or claude."));
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

export async function setup() {
  print(dim(WOLF));
  print(bold("  WOLFPACK — AI Agent Bridge"));
  print(dim("  Deploy your pack. Command from anywhere."));
  print("");

  // Detect non-interactive shells (CI, piped stdin, redirected stdout) so
  // setup can apply deterministic local-only defaults without prompting.
  // process.stdin.isTTY is undefined when not a TTY — treat any non-true
  // value as non-interactive.
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive) {
    print(yellow("  Non-interactive shell detected (no TTY)."));
    print(dim("  All prompts will be skipped; defaults applied silently."));
    print(dim("  Run from an interactive terminal to be prompted."));
    print("");
  }

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
  const defaultDev = resolve(homedir(), "Dev");
  const rawDevDir = interactive ? ask(`  Projects directory [${defaultDev}]: `) : "";
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
  const portStr = interactive ? ask("  Server port [18790]: ") : "";
  const port = Math.max(1024, Math.min(65535, Number(portStr) || 18790));

  // Tailscale remote endpoint. A remote URL is persisted and advertised only
  // after `serve status --json` proves it proxies to this Wolfpack port.
  let verifiedRemoteHostname: string | undefined;
  if (hasTailscale && tsBin) {
    const runTailscale = (args: readonly string[]): string => {
      const [file, fileArgs] = IS_LINUX
        ? ["sudo", [tsBin, ...args]]
        : [tsBin, [...args]];
      return execFileSync(file, fileArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    };
    const tryGetTsHostname = (): string | undefined => {
      try { return parseTailscaleHostname(runTailscale(["status", "--self", "--json"])); } catch { return undefined; }
    };
    let signedInHostname = tryGetTsHostname();
    if (!signedInHostname) {
      if (IS_MACOS) {
        print(dim("  Launching Tailscale.app for sign-in..."));
        try { execSync("open /Applications/Tailscale.app", { stdio: "ignore" }); } catch (e: unknown) {
          log.warn("setup: failed to launch Tailscale.app", { error: e instanceof Error ? e.message : String(e) });
        }
      } else if (IS_LINUX) {
        print(dim("  Run 'sudo tailscale up' in another terminal to sign in."));
      }
      while (!signedInHostname && interactive) {
        const retry = ask("  Sign in, then press Enter to retry (or type skip): ");
        if (retry.toLowerCase() === "skip") break;
        signedInHostname = tryGetTsHostname();
      }
    }
    if (signedInHostname) {
      const configured = configureTailscaleRemoteAccess({ binary: tsBin, port, run: (_file, args) => runTailscale(args) });
      if (configured.status === "verified") {
        verifiedRemoteHostname = configured.hostname;
        print(green(`  Tailscale serving at https://${verifiedRemoteHostname}/`));
      } else {
        print(red("  Tailscale serve was not verified; no phone QR will be shown."));
        print(dim(`  Retry: ${IS_LINUX ? "sudo " : ""}${tsBin} serve --bg ${port}`));
      }
    } else if (hasTailscale) {
      print(yellow("  Tailscale is not signed in; phone and remote access remain unavailable."));
    }
  }

  const config: Config = {
    devDir,
    port,
    ...(verifiedRemoteHostname && { tailscaleHostname: verifiedRemoteHostname }),
  };
  saveConfig(config);

  initializeProviderSettingsFile({
    settingsPath: join(WOLFPACK_DIR, "bridge-settings.json"),
    pathValue: process.env.PATH,
  });

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

  const installService = interactive
    ? ask("  Start wolfpack automatically on login? [Y/n] ")
    : "n";
  let serviceInstalled = false;
  if (!interactive) {
    print(dim("  Non-interactive mode — skipping service install."));
    print(dim("  Run 'wolfpack service install' to start automatically on login."));
  } else if (installService.toLowerCase() !== "n") {
    try {
      serviceInstall();
      serviceInstalled = true;
    } catch (e) {
      print(red(`  Service install failed: ${e}`));
    }
  }

  printSetupCompletion({
    port: config.port,
    remoteUrl: verifiedRemoteHostname ? remoteUrl(config) : null,
    serviceInstalled,
  });
}
