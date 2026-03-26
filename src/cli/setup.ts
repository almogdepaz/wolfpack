/**
 * Interactive setup wizard.
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir, platform } from "node:os";
import { printQR } from "../qr.js";
import { print, bold, green, red, dim, yellow, WOLF } from "./formatting.js";
import {
  CONFIG_PATH,
  hasTTY,
  ask,
  saveConfig,
  sleepSync,
  remoteUrl,
  type Config,
} from "./config.js";
import { serviceInstall } from "./service.js";
import { createLogger } from "../log.js";

const log = createLogger("setup");

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

const TAILSCALE_MAC_CLI =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function tailscaleBin(): string | null {
  try {
    execSync("tailscale version", { stdio: "ignore" });
    return "tailscale";
  } catch { /* probe: tailscale not in PATH */ }
  try {
    execSync(`${TAILSCALE_MAC_CLI} version`, { stdio: "ignore" });
    return TAILSCALE_MAC_CLI;
  } catch { /* probe: Tailscale.app CLI not found */ }
  return null;
}

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

export async function setup() {
  print(dim(WOLF));
  print(bold("  WOLFPACK — AI Agent Bridge"));
  print(dim("  Deploy your pack. Command from anywhere."));
  print("");

  print(bold("  Checking prerequisites...\n"));

  const hasTmux = check("tmux", "tmux -V");
  if (!hasTmux) {
    if (IS_MACOS) {
      print(dim("    → brew install tmux"));
    } else if (IS_LINUX) {
      print(dim("    → sudo apt install tmux"));
    }
  }
  const tsBin = tailscaleBin();
  const hasTailscale = !!tsBin;
  if (hasTailscale) {
    print(`  ${green("✓")} Tailscale`);
  } else {
    print(`  ${red("✗")} Tailscale`);
  }

  print("");

  const missing: string[] = [];
  if (!hasTmux) missing.push("tmux");
  if (!hasTailscale) missing.push("tailscale");

  if (missing.length > 0) {
    if (IS_MACOS) {
      try {
        execSync("brew --version", { stdio: "ignore" });
      } catch { /* expected: homebrew not installed */
        print(red("  Homebrew is required to install missing dependencies."));
        print(dim("  Install from https://brew.sh"));
        process.exit(1);
      }
    } else if (IS_LINUX) {
      try {
        execSync("apt --version", { stdio: "ignore" });
      } catch { /* expected: apt not available on this system */
        print(red("  apt is required to install missing dependencies."));
        process.exit(1);
      }
    } else {
      print(red("  Unsupported platform. Please install manually: " + missing.join(", ")));
      process.exit(1);
    }

    print(`  Will install: ${bold(missing.join(", "))}`);
    if (hasTTY) {
      const proceed = ask("  Proceed? (y/n) ");
      if (proceed.toLowerCase() !== "y") {
        print(red("  Aborted."));
        process.exit(1);
      }
    }

    if (IS_MACOS) {
      const brewPkgs = missing.filter((p) => p !== "tailscale");
      const brewCasks = missing.filter((p) => p === "tailscale");
      if (brewPkgs.length > 0) {
        print(`  Installing ${brewPkgs.join(", ")}...`);
        execSync(`brew install --quiet ${brewPkgs.join(" ")}`, { stdio: "inherit" });
      }
      if (brewCasks.length > 0) {
        print("  Installing Tailscale (GUI app)...");
        execSync("brew install --cask --quiet tailscale", { stdio: "inherit" });
      }
    } else if (IS_LINUX) {
      const aptPkgMap: Record<string, string> = { tmux: "tmux" };
      const aptPkgs = missing
        .filter((p) => p !== "tailscale")
        .map((p) => aptPkgMap[p] || p);
      if (aptPkgs.length > 0) {
        print(`  Installing ${aptPkgs.join(", ")}...`);
        execSync(`sudo apt update -qq && sudo apt install -y -qq ${aptPkgs.join(" ")}`, { stdio: "inherit" });
      }
      if (missing.includes("tailscale")) {
        print("  Installing Tailscale...");
        execSync("curl -fsSL https://tailscale.com/install.sh | sudo sh", { stdio: "inherit" });
      }
    }

    print("");
    let verifyFail = false;
    for (const pkg of missing) {
      if (pkg === "tailscale") {
        if (tailscaleBin()) {
          print(`  ${green("✓")} Tailscale installed`);
          if (IS_MACOS) {
            print(dim("  Open Tailscale.app and sign in to enable remote access."));
          } else {
            print(dim("  Run 'sudo tailscale up' to sign in."));
          }
        } else {
          print(`  ${red("✗")} Tailscale failed to install`);
          verifyFail = true;
        }
      } else {
        if (!check(pkg, `${pkg} --version`)) {
          verifyFail = true;
        }
      }
    }

    if (verifyFail) {
      print(red("\n  Some dependencies failed to install."));
      process.exit(1);
    }

    print("");
  }

  // Dev directory — retry loop so typos don't force a restart
  const defaultDev = resolve(homedir(), "Dev");
  const SYSTEM_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/sys", "/proc"];
  const MAX_DIR_ATTEMPTS = 5;
  let devDir = "";

  for (let attempt = 0; attempt < MAX_DIR_ATTEMPTS; attempt++) {
    const rawDevDir = ask(`  Projects directory [${defaultDev}]: `) || defaultDev;
    devDir = resolve(rawDevDir);

    if (SYSTEM_PREFIXES.some(p => devDir === p || devDir.startsWith(p + "/"))) {
      print(red(`  Refusing to use system directory: ${devDir}`));
      continue;
    }
    if (!devDir.startsWith(homedir())) {
      print(yellow(`  Warning: projects directory is outside your home folder.`));
    }

    if (existsSync(devDir)) break;

    const choice = ask(`  ${devDir} doesn't exist. (c)reate it, (n)ew path, or (q)uit? `).toLowerCase();
    if (choice === "c") {
      mkdirSync(devDir, { recursive: true });
      print(green(`  Created ${devDir}`));
      break;
    } else if (choice === "n") {
      continue;
    } else if (choice === "q") {
      print(red("  Aborted."));
      process.exit(1);
    }
    // retry — loop again
  }

  if (!devDir || !existsSync(devDir)) {
    print(red("  No valid directory selected. Aborting."));
    process.exit(1);
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

  if (serviceInstalled) {
    print(green("  Wolfpack is running as a background service."));
    print(dim("  Use 'wolfpack service stop' to stop, 'wolfpack service status' to check."));
    print("");
    process.exit(0);
  }
}
