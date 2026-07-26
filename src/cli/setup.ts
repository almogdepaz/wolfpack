/**
 * Interactive setup wizard.
 */
import { execSync, execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { printQR } from "../qr.js";
import { print, bold, green, red, dim, yellow, WOLF } from "./formatting.js";
import {
  CONFIG_PATH,
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  hasTTY,
  ask,
  saveConfig,
  sleepSync,
  remoteUrl,
  tailscaleBin,
  type Config,
} from "./config.js";
import { serviceInstall } from "./service.js";
import { createLogger } from "../log.js";
import { initializeProviderSettingsFile } from "../initial-provider-settings.js";
import {
  PI_INTEGRATION_PACKAGES,
  acceptsPiIntegrationInstall,
  installPiIntegration,
  piIntegrationDisclosureLines,
  planPiIntegrationSetup,
} from "./pi-integration.js";

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

  // Detect non-interactive shells (CI, piped stdin, redirected stdout)
  // and announce up-front. Without this, every prompt silently no-ops via
  // the hasTTY=false flip in `ask()`, leaving operators wondering why
  // setup "just finished" with nothing changed.
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

  const tsBin = tailscaleBin();
  const hasTailscale = !!tsBin;
  if (hasTailscale) {
    print(`  ${green("✓")} Tailscale`);
  } else {
    print(`  ${red("✗")} Tailscale ${dim("(optional — needed for remote access)")}`);
  }

  print("");


  // ── Install optional missing deps (tailscale only) ──
  if (!hasTailscale) {
    const installTs = hasTTY ? ask("  Install Tailscale for remote access? (y/n) ") : "n";
    if (installTs.toLowerCase() === "y") {
      installPackages(["tailscale"]);
    }
    print("");
  }

  // Dev directory
  const defaultDev = resolve(homedir(), "Dev");
  const rawDevDir = ask(`  Projects directory [${defaultDev}]: `) || defaultDev;
  const devDir = resolve(rawDevDir);

  const SYSTEM_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/sys", "/proc"];
  if (SYSTEM_PREFIXES.some(p => devDir === p || devDir.startsWith(p + "/"))) {
    print(red(`  Refusing to use system directory: ${devDir}`));
    process.exit(1);
  }
  if (!devDir.startsWith(homedir())) {
    print(yellow(`  Warning: projects directory is outside your home folder.`));
  }

  if (!existsSync(devDir)) {
    const create = ask(`  ${devDir} doesn't exist. Create it? (y/n) `);
    if (create.toLowerCase() === "y") {
      mkdirSync(devDir, { recursive: true });
      print(green(`  Created ${devDir}`));
    } else {
      print(red("  Aborted."));
      process.exit(1);
    }
  }

  // Port
  const portStr = ask("  Server port [18790]: ");
  const port = Math.max(1024, Math.min(65535, Number(portStr) || 18790));

  // Tailscale hostname
  let tailscaleHostname: string | undefined;
  const sudoPrefix = IS_LINUX ? "sudo " : "";

  function tryGetTsHostname(): string | undefined {
    try {
      const status = execSync(`${sudoPrefix}${tsBin} status --self --json`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(status);
      return parsed.Self?.DNSName?.replace(/\.$/, "") || undefined;
    } catch { /* expected: tailscale not running or not signed in */
      return undefined;
    }
  }

  if (hasTailscale) {
    tailscaleHostname = tryGetTsHostname();

    if (!tailscaleHostname) {
      if (IS_MACOS) {
        print(dim("  Launching Tailscale.app for sign-in..."));
        try { execSync("open /Applications/Tailscale.app", { stdio: "ignore" }); } catch (e: unknown) {
          log.warn("setup: failed to launch Tailscale.app", { error: e instanceof Error ? e.message : String(e) });
        }
      } else if (IS_LINUX) {
        print(dim("  Run 'sudo tailscale up' in another terminal to sign in."));
      }

      print(yellow("  Waiting for Tailscale sign-in... (press Enter to skip)"));

      let ttyFd: number | null = null;
      try {
        ttyFd = openSync("/dev/tty", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      } catch { /* expected: no tty available in non-interactive mode */ }

      const MAX_POLLS = 60;
      for (let i = 0; i < MAX_POLLS; i++) {
        sleepSync(2000);
        tailscaleHostname = tryGetTsHostname();
        if (tailscaleHostname) break;

        if (ttyFd !== null) {
          try {
            const skipBuf = Buffer.alloc(64);
            const bytesRead = readSync(ttyFd, skipBuf, 0, skipBuf.length, null);
            if (bytesRead > 0) {
              print(dim("  Skipped Tailscale sign-in."));
              break;
            }
          } catch { /* expected: EAGAIN on nonblocking read */ }
        }

        if (i > 0 && i % 5 === 0) {
          const remaining = Math.round((MAX_POLLS - i) * 2);
          process.stdout.write(dim(`  Still waiting... (${remaining}s remaining, Enter to skip)\n`));
        }
      }

      if (ttyFd !== null) {
        try { closeSync(ttyFd); } catch (e: unknown) {
          log.warn("setup: failed to close tty fd", { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (!tailscaleHostname) {
        print(yellow("  Tailscale not signed in. Run 'wolfpack setup' again after signing in."));
      }
    }

    if (tailscaleHostname) {
      print(dim(`  Detected Tailscale hostname: ${tailscaleHostname}`));
      try {
        execSync(`${sudoPrefix}${tsBin} serve --bg ${port}`, { stdio: "inherit" });
        print(green(`  Tailscale serving at https://${tailscaleHostname}/`));
      } catch (e: unknown) {
        log.warn("tailscale serve failed", { error: e instanceof Error ? e.message : String(e) });
        print(red("  Failed to configure tailscale serve. You can do it manually later."));
        print(dim(`  Try: ${sudoPrefix}tailscale serve --bg ${port}`));
      }
    }
  }

  const config: Config = { devDir, port, tailscaleHostname };
  saveConfig(config);

  const initialSettings = initializeProviderSettingsFile({
    settingsPath: join(WOLFPACK_DIR, "bridge-settings.json"),
    pathValue: process.env.PATH,
  });
  if (initialSettings) {
    const detectedProviders = initialSettings.cmds.slice(1).map(entry => entry.cmd);
    const readinessSummary = detectedProviders.length > 0
      ? `Enabled detected providers: ${detectedProviders.join(", ")}`
      : "No coding-agent providers detected; enabled shell only";
    print(dim(`  ${readinessSummary}.`));
  }

  const piIntegrationMode = planPiIntegrationSetup(process.env.PATH, interactive);
  if (piIntegrationMode === "prompt") {
    print("");
    print(bold("  Optional Pi subagent integration:"));
    for (const line of piIntegrationDisclosureLines()) {
      print(dim(line));
    }
    const installPi = ask("  Install the Pi extension and Wolfpack skills? [y/N] ");
    if (acceptsPiIntegrationInstall(installPi)) {
      const installResult = installPiIntegration({ pathValue: process.env.PATH });
      if (installResult.status === "installed") {
        print(green("  Installed Pi task delegation and Wolfpack skills."));
        print(dim("  Start a fresh Pi session, or run /reload in an existing session."));
      } else {
        print(red(`  Pi integration install stopped at ${installResult.failedSource}.`));
        print(dim(`  Retry: ${installResult.retryCommand}`));
        print(dim("  Then run 'wolfpack setup' again to finish the integration."));
      }
    } else {
      print(dim("  Skipped optional Pi integration."));
    }
  } else if (piIntegrationMode === "guidance") {
    print("");
    print(dim("  Pi detected; non-interactive mode skipped the optional subagent integration."));
    print(dim("  Install it explicitly:"));
    for (const source of PI_INTEGRATION_PACKAGES) {
      print(dim(`    pi install ${source}`));
    }
  }

  print("");
  print(green("  Setup complete!"));
  print(`  Config saved to ${dim(CONFIG_PATH)}`);
  print("");

  const installService = hasTTY
    ? ask("  Start wolfpack automatically on login? [Y/n] ")
    : "n";
  let serviceInstalled = false;
  if (!hasTTY) {
    print(dim("  Non-interactive mode — skipping service install."));
    print(dim("  Run 'wolfpack service install' to start automatically on login."));
  } else if (installService.toLowerCase() !== "n") {
    try {
      serviceInstall();
      serviceInstalled = true;
    } catch (e) {
      print(red(`  Service install failed: ${e}`));
    }
  } else {
    print(`  Run ${bold("wolfpack")} to start the server.`);
    print(`  Or ${bold("wolfpack service install")} to auto-start on login.`);
  }

  const url = remoteUrl(config) ?? `http://localhost:${config.port}/`;
  print(`  Access from phone: ${bold(url)}`);
  print("");
  print(dim("  Scan to open on your phone:"));
  print("");
  printQR(url);
  print("");
  print(yellow("  Security: Always use the Tailscale hostname URL — not your machine's IP (it won't work)."));
  print("");
  print(bold("  JWT Authentication:"));
  print(dim("  1. Generate a secret:  openssl rand -base64 48"));
  print(dim("  2. Export before setup or service install:  export WOLFPACK_JWT_SECRET=\"your-secret\""));
  print(dim("  3. Service install stores configured JWT settings in a private credential file."));
  print("");

  if (serviceInstalled) {
    print(green("  Wolfpack is running as a background service."));
    print(dim("  Use 'wolfpack service stop' to stop, 'wolfpack service status' to check."));
    print("");
    process.exit(0);
  }
}
