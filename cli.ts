#!/usr/bin/env bun
import { execSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { platform, homedir } from "node:os";
import { printQR } from "./qr.js";
import { xmlEsc, systemdEsc, isValidPort } from "./validation.js";

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

// read from package.json at compile time via bun's import
import pkg from "./package.json";
const VERSION: string = pkg.version;

const WOLFPACK_DIR = join(homedir(), ".wolfpack");
const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

export interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

let hasTTY = true;
function ask(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    hasTTY = false;
    // No tty — return empty so callers use defaults
    return "";
  }
  const n = readSync(fd, buf, 0, buf.length, null);
  closeSync(fd);
  return buf.subarray(0, n).toString("utf-8").trim();
}

function print(msg: string) {
  console.log(msg);
}

const WOLF = `
        ...:.
           :=+=:
       . .-*####+-
      .- :++**####*=.
       -  :+***#####*=:.
       :   .+**######*+==++++++=:..
       ..   .=*#######*++++====+=--=-.
       .:.-    -+**######**+*#*+=-:-===:
     -.  ..     -++++***#**++*#*--:---===:
     -.:--==+=--=*++*+**********+==------++-
     .:----=++*++##########******+=====--=+#=-.
       .::-----=++*#%%%%%%#***###*+===--==+*=++=:.
         ...::::-=+*#%%############*+-----===+****+=:.
          :--=-====+******++****##***-.::--++*######**
         .++-+++++***********#*+*#***=.:---=+**=--=+==
         -**++*++****+***##*++*****++=. ----=+=.  ..:-
        .+##***+*+*****##*#=-=**=-=-::. -**-::-==+++++
        :*%%*+=+=+****##**++****+**+-.. -*=-   .::::-=
        .-#%#*+*+**#***+++**+****+*++=--+=::-:..:...-+
         =###***=*+++++-=*=+++++-====-=:-=--:=---==---
        .:-+***+=*+++**+++===*++++=--:=  ::=::-=----++
          .+****+++++*##+***++=+*-.:--:..-===---=-:-++
          .-+###**+++*#****+=---:--==.--=:==-==:::-=++
            :####*****+++======:.. :...:::---:.=------
            .=###***+++*++++--:.:::.   :-=::.:..-:---:
             :+**++++++*++*+=-:: .. ...... ..   .:..::
`;
function bold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}
function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isPortInUse(port: number): boolean {
  try {
    const p = Math.floor(Number(port));
    if (!isValidPort(p)) return false;
    // execFileSync with array args — no shell interpolation
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-i", `:${p}`, "-t"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0;
    } else {
      const out = execFileSync("ss", ["-tlnp", "sport", "=", `:${p}`], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // ss always outputs a header line, so >1 line means a listener exists
      return out.split("\n").length > 1;
    }
  } catch {
    return false;
  }
}

function waitForPortFree(port: number, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortInUse(port)) return;
    sleepSync(500);
  }
  print(yellow(`  Warning: port ${port} still in use after ${timeoutMs / 1000}s`));
}

const TAILSCALE_MAC_CLI =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function tailscaleBin(): string | null {
  try {
    execSync("tailscale version", { stdio: "ignore" });
    return "tailscale";
  } catch {}
  try {
    execSync(`${TAILSCALE_MAC_CLI} version`, { stdio: "ignore" });
    return TAILSCALE_MAC_CLI;
  } catch {}
  return null;
}

function check(name: string, cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    print(`  ${green("✓")} ${name}`);
    return true;
  } catch {
    print(`  ${red("✗")} ${name}`);
    return false;
  }
}

function remoteUrl(config: Config): string | null {
  if (!config.tailscaleHostname) return null;
  return `https://${config.tailscaleHostname}`;
}

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveConfig(c: Config) {
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

async function setup() {
  print(dim(WOLF));
  print(bold("  WOLFPACK — AI Agent Bridge"));
  print(dim("  Deploy your pack. Command from anywhere."));
  print("");

  // Check prerequisites
  print(bold("  Checking prerequisites...\n"));

  const hasTmux = check("tmux", "tmux -V");
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
      } catch {
        print(red("  Homebrew is required to install missing dependencies."));
        print(dim("  Install from https://brew.sh"));
        process.exit(1);
      }
    } else if (IS_LINUX) {
      try {
        execSync("apt --version", { stdio: "ignore" });
      } catch {
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
      // Map package names to apt package names
      const aptPkgMap: Record<string, string> = {
        tmux: "tmux",
      };
      const aptPkgs = missing
        .filter((p) => p !== "tailscale")
        .map((p) => aptPkgMap[p] || p);

      if (aptPkgs.length > 0) {
        print(`  Installing ${aptPkgs.join(", ")}...`);
        execSync(`sudo apt update -qq && sudo apt install -y -qq ${aptPkgs.join(" ")}`, {
          stdio: "inherit",
        });
      }

      if (missing.includes("tailscale")) {
        print("  Installing Tailscale...");
        execSync("curl -fsSL https://tailscale.com/install.sh | sudo sh", {
          stdio: "inherit",
        });
      }
    }

    // Verify
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

  // Dev directory
  const defaultDev = join(homedir(), "Dev");
  const rawDevDir = ask(`  Projects directory [${defaultDev}]: `) || defaultDev;
  const devDir = resolve(rawDevDir);

  // Validate devDir
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
    } catch {
      return undefined;
    }
  }

  if (hasTailscale) {
    tailscaleHostname = tryGetTsHostname();

    // Wait for Tailscale sign-in if not logged in
    if (!tailscaleHostname) {
      if (IS_MACOS) {
        print(dim("  Launching Tailscale.app for sign-in..."));
        try {
          execSync("open /Applications/Tailscale.app", { stdio: "ignore" });
        } catch {}
      } else if (IS_LINUX) {
        print(dim("  Run 'sudo tailscale up' in another terminal to sign in."));
      }

      print(yellow("  Waiting for Tailscale sign-in... (press Enter to skip)"));

      // Non-blocking tty fd for skip detection
      let ttyFd: number | null = null;
      try {
        ttyFd = openSync("/dev/tty", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      } catch {}

      const MAX_POLLS = 60; // ~2 min at 2s intervals
      for (let i = 0; i < MAX_POLLS; i++) {
        sleepSync(2000);
        tailscaleHostname = tryGetTsHostname();
        if (tailscaleHostname) break;

        // Check for Enter keypress (non-blocking)
        if (ttyFd !== null) {
          try {
            const skipBuf = Buffer.alloc(64);
            const bytesRead = readSync(ttyFd, skipBuf, 0, skipBuf.length, null);
            if (bytesRead > 0) {
              print(dim("  Skipped Tailscale sign-in."));
              break;
            }
          } catch {
            // EAGAIN — no input yet, continue polling
          }
        }

        // Progress dots every 10s
        if (i > 0 && i % 5 === 0) {
          const remaining = Math.round((MAX_POLLS - i) * 2);
          process.stdout.write(dim(`  Still waiting... (${remaining}s remaining, Enter to skip)\n`));
        }
      }

      if (ttyFd !== null) {
        try { closeSync(ttyFd); } catch {}
      }

      if (!tailscaleHostname) {
        print(yellow("  Tailscale not signed in. Run 'wolfpack setup' again after signing in."));
      }
    }

    // Setup tailscale serve
    if (tailscaleHostname) {
      print(dim(`  Detected Tailscale hostname: ${tailscaleHostname}`));
      try {
        execSync(
          `${sudoPrefix}${tsBin} serve --bg ${port}`,
          { stdio: "inherit" },
        );
        print(
          green(
            `  Tailscale serving at https://${tailscaleHostname}/`,
          ),
        );
      } catch {
        print(
          red(
            "  Failed to configure tailscale serve. You can do it manually later.",
          ),
        );
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
  // Offer launchd service — default yes (interactive), skip (non-interactive)
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

async function start() {
  let config = loadConfig();
  if (!config) {
    print("  No config found. Running setup first...\n");
    await setup();
    // setup calls process.exit(0) on successful service install.
    // if we're still here, service install failed or was declined — exit cleanly.
    process.exit(0);
  }

  // Service daemon mode — just start the server
  if (process.env.WOLFPACK_SERVICE === "1") {
    process.env.WOLFPACK_DEV_DIR = config.devDir;
    process.env.WOLFPACK_PORT = String(config.port);
    await import("./serve.js");
    return;
  }

  // CLI invocation — ensure service is running, never start foreground
  const url = remoteUrl(config);
  const wasRunning = isServiceRunning();
  try {
    serviceInstall();
  } catch (e) {
    print(red(`  Service install failed: ${e}`));
    print(dim("  Run 'wolfpack service install' to retry."));
  }
  if (wasRunning && !isServiceRunning()) {
    print(yellow("  Service was running but didn't restart."));
    print(yellow(`  Run ${bold("wolfpack service start")} to restart it.`));
  }

  print(dim(WOLF));
  print(bold("  WOLFPACK"));
  print("");
  print(`  Local:    ${dim(`http://localhost:${config.port}/`)}`);
  if (url) print(`  Remote:   ${dim(url)}`);
  print("");
  print(dim("  Scan to open on your phone:"));
  print("");
  printQR(url ?? `http://localhost:${config.port}/`);
  print("");
}

// ── Service management (launchd on macOS, systemd on Linux) ──

const PLIST_LABEL = "com.wolfpack.server";
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const SYSTEMD_SERVICE = "wolfpack";
const SYSTEMD_PATH = join(
  homedir(),
  ".config",
  "systemd",
  "user",
  `${SYSTEMD_SERVICE}.service`,
);

function programArgs(): string[] {
  const exe = process.execPath;
  // When running via `bun run cli.ts`, execPath is the bun binary —
  // we need to add the script path so launchd/systemd actually runs wolfpack.
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime && process.argv[1]) {
    return [exe, resolve(process.argv[1])];
  }
  // Copy binary to stable path so service survives cache clearing
  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");
  if (exe !== stableBin && existsSync(exe)) {
    try {
      mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
      copyFileSync(exe, stableBin);
      chmodSync(stableBin, 0o755);
      return [stableBin];
    } catch {}
  }
  return [exe];
}

function generatePlist(): string {
  const args = programArgs();
  const config = loadConfig();
  const env: Record<string, string> = { WOLFPACK_SERVICE: "1" };
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key>\n      <string>${xmlEsc(v)}</string>`)
    .join("\n");

  const logPath = xmlEsc(join(homedir(), ".wolfpack", "wolfpack.log"));

  const argsXml = args.map(a => `    <string>${xmlEsc(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEsc(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin</string>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;
}

function generateSystemdUnit(): string {
  const args = programArgs();
  const config = loadConfig();
  const envLines: string[] = [
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin`,
    `Environment=WOLFPACK_SERVICE=1`,
  ];
  if (config?.devDir) envLines.push(`Environment="WOLFPACK_DEV_DIR=${systemdEsc(config.devDir)}"`);
  if (config?.port) envLines.push(`Environment="WOLFPACK_PORT=${config.port}"`);

  const quotedArgs = args.map(a => `"${systemdEsc(a)}"`).join(" ");
  return `[Unit]
Description=Wolfpack AI Agent Bridge
After=network.target

[Service]
Type=simple
ExecStart=${quotedArgs}
Restart=always
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

// launchd domain target for the current user (e.g. "gui/501")
const LAUNCHD_DOMAIN = `gui/${process.getuid()}`;
const LAUNCHD_TARGET = `${LAUNCHD_DOMAIN}/${PLIST_LABEL}`;

function launchdBootout() {
  try {
    execSync(`launchctl bootout ${LAUNCHD_TARGET} 2>/dev/null`);
  } catch {}
}

function launchdBootstrap() {
  execSync(`launchctl bootstrap ${LAUNCHD_DOMAIN} "${PLIST_PATH}"`);
  execSync(`launchctl kickstart ${LAUNCHD_TARGET}`);
}

function serviceInstall() {
  const config = loadConfig();
  if (!config) {
    print(red("  Run 'wolfpack setup' first."));
    process.exit(1);
  }

  // stop gracefully first (handles both macOS and Linux)
  if (isServiceRunning()) {
    serviceStop();
  }
  // always wait for port — service may appear "stopped" to launchctl/systemd
  // while the process is still dying and holding the port
  if (isPortInUse(config.port)) {
    waitForPortFree(config.port);
  }

  if (IS_MACOS) {
    const plist = generatePlist();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), {
      recursive: true,
    });
    writeFileSync(PLIST_PATH, plist);

    // Stop existing service, then register and start fresh
    launchdBootout();
    launchdBootstrap();

    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Plist: ${PLIST_PATH}`));
  } else if (IS_LINUX) {
    const unit = generateSystemdUnit();
    mkdirSync(join(homedir(), ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(SYSTEMD_PATH, unit);

    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);

    // Enable linger so user services start at boot, not just on login
    try {
      const user = process.env.USER || "";
      if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
        print(dim("  Note: Could not validate USER for linger. Skipping."));
      } else {
        execFileSync("sudo", ["loginctl", "enable-linger", user]);
      }
    } catch {
      print(dim("  Note: Could not enable linger. Service may not start at boot."));
      print(dim("  Run: sudo loginctl enable-linger $USER"));
    }

    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Unit: ${SYSTEMD_PATH}`));
  } else {
    print(red("  Service install not supported on this platform."));
    process.exit(1);
  }

  print(dim(`  Log:   ~/.wolfpack/wolfpack.log`));
  print("");
  print("  Wolfpack will now start automatically on login.");
  print(`  Use ${bold("wolfpack service stop")} to stop.`);
  print(`  Use ${bold("wolfpack service uninstall")} to remove.`);
  print("");
}

function serviceUninstall() {
  if (IS_MACOS) {
    launchdBootout();
    try {
      unlinkSync(PLIST_PATH);
    } catch {}
  } else if (IS_LINUX) {
    try {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE} 2>/dev/null`);
    } catch {}
    try {
      execSync(`systemctl --user disable ${SYSTEMD_SERVICE} 2>/dev/null`);
    } catch {}
    try {
      unlinkSync(SYSTEMD_PATH);
    } catch {}
    try {
      execSync("systemctl --user daemon-reload");
    } catch {}
  }
  print(green("  Wolfpack service removed."));
}

function serviceStop() {
  try {
    if (IS_MACOS) {
      launchdBootout();
    } else if (IS_LINUX) {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service stopped."));
  } catch {
    print(red("  Failed to stop service."));
  }
}

function serviceStart() {
  try {
    if (IS_MACOS) {
      launchdBootstrap();
    } else if (IS_LINUX) {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service started."));
  } catch {
    print(red("  Failed to start service."));
  }
}

function isServiceRunning(): boolean {
  try {
    if (IS_MACOS) {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, {
        encoding: "utf-8",
      });
      return /pid\s*=\s*\d+/i.test(out);
    } else if (IS_LINUX) {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, {
        encoding: "utf-8",
      }).trim();
      return out === "active";
    }
  } catch {}
  return false;
}

function serviceStatus() {
  print(dim(`  Version: ${VERSION}`));
  if (IS_MACOS) {
    try {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, {
        encoding: "utf-8",
      });
      const pidMatch = out.match(/pid\s*=\s*(\d+)/i);
      if (pidMatch) {
        print(green(`  Wolfpack is running (PID ${pidMatch[1]})`));
      } else {
        print(dim("  Wolfpack service is loaded but not running."));
      }
    } catch {
      if (existsSync(PLIST_PATH)) {
        print(dim("  Wolfpack service is installed but not loaded."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else if (IS_LINUX) {
    try {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, {
        encoding: "utf-8",
      }).trim();
      if (out === "active") {
        const pidOut = execSync(
          `systemctl --user show ${SYSTEMD_SERVICE} --property=MainPID --value`,
          { encoding: "utf-8" },
        ).trim();
        print(green(`  Wolfpack is running (PID ${pidOut})`));
      } else {
        print(dim(`  Wolfpack service status: ${out}`));
      }
    } catch {
      if (existsSync(SYSTEMD_PATH)) {
        print(dim("  Wolfpack service is installed but not running."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else {
    print(dim("  Service status not supported on this platform."));
  }
}

function uninstall() {
  serviceUninstall();

  try {
    rmSync(WOLFPACK_DIR, { recursive: true, force: true });
  } catch {}

  print("");
  print(green("  Wolfpack uninstalled."));
  print(dim(`  Removed ${WOLFPACK_DIR}`));
  print("");
  print(dim("  The wolfpack binary remains at: " + process.execPath));
  print(dim("  Delete it manually if you want a full removal."));
  print("");
}

// ── CLI dispatch ──

const cmd = process.argv[2];
const subcmd = process.argv[3];

async function main() {
  if (cmd === "setup") {
    await setup();
  } else if (cmd === "service") {
    if (subcmd === "install") serviceInstall();
    else if (subcmd === "uninstall") serviceUninstall();
    else if (subcmd === "stop") serviceStop();
    else if (subcmd === "start") serviceStart();
    else if (subcmd === "status") serviceStatus();
    else {
      print("  Usage: wolfpack service [install|uninstall|start|stop|status]");
    }
  } else if (cmd === "uninstall") {
    uninstall();
  } else if (cmd === "worker") {
    // Ralph worker subcommand — shift argv so ralph-macchio sees correct args
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./ralph-macchio.js");
  } else {
    await start();
  }
}

// only run when executed directly, not when imported for tests
if (import.meta.main) {
  main().catch((e) => {
    print(red(`  Fatal error: ${e.message || e}`));
    process.exit(1);
  });
}
