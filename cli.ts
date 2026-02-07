#!/usr/bin/env bun
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { printQR } from "./qr.js";

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

const WOLFPACK_DIR = join(process.env.HOME ?? "~", ".wolfpack");
const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

function ask(question: string): Promise<string> {
  const fs = require("node:fs");
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch {
    // No tty (piped context) — read from stdin
    const n = fs.readSync(0, buf, 0, buf.length, null);
    return Promise.resolve(buf.subarray(0, n).toString("utf-8").split("\n")[0].trim());
  }
  const n = fs.readSync(fd, buf, 0, buf.length, null);
  fs.closeSync(fd);
  return Promise.resolve(buf.subarray(0, n).toString("utf-8").trim());
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

function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(c: Config) {
  mkdirSync(WOLFPACK_DIR, { recursive: true });
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
    const proceed = await ask("  Proceed? (y/n) ");
    if (proceed.toLowerCase() !== "y") {
      print(red("  Aborted."));
      process.exit(1);
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
        if (check(pkg, `${pkg} --version`)) {
          // check() already prints ✓
        } else {
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
  const defaultDev = join(process.env.HOME ?? "~", "Dev");
  const devDir =
    (await ask(`  Projects directory [${defaultDev}]: `)) || defaultDev;

  if (!existsSync(devDir)) {
    const create = await ask(`  ${devDir} doesn't exist. Create it? (y/n) `);
    if (create.toLowerCase() === "y") {
      mkdirSync(devDir, { recursive: true });
      print(green(`  Created ${devDir}`));
    } else {
      print(red("  Aborted."));
      process.exit(1);
    }
  }

  // Port
  const portStr = await ask("  Server port [18790]: ");
  const port = Number(portStr) || 18790;

  // Tailscale hostname
  let tailscaleHostname: string | undefined;
  const sudoPrefix = IS_LINUX ? "sudo " : "";
  if (hasTailscale) {
    try {
      const status = execSync(`${sudoPrefix}${tsBin} status --self --json`, {
        encoding: "utf-8",
      });
      const parsed = JSON.parse(status);
      tailscaleHostname = parsed.Self?.DNSName?.replace(/\.$/, "");
    } catch {}

    if (tailscaleHostname) {
      print(dim(`  Detected Tailscale hostname: ${tailscaleHostname}`));
    } else if (IS_LINUX) {
      print(dim("  Tailscale not logged in. Run 'sudo tailscale up' first."));
    }

    // Setup tailscale serve
    if (tailscaleHostname) {
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
        if (IS_LINUX) {
          print(dim(`  Try: sudo tailscale serve --bg ${port}`));
        }
      }
    }
  }

  const config: Config = { devDir, port, tailscaleHostname };
  saveConfig(config);

  print("");
  print(green("  Setup complete!"));
  print(`  Config saved to ${dim(CONFIG_PATH)}`);
  print("");
  // Offer launchd service
  const installService = await ask(
    "  Start wolfpack automatically on login? (y/n) ",
  );
  if (installService.toLowerCase() === "y") {
    saveConfig(config); // ensure config is saved before generating plist
    try {
      serviceInstall();
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
}

async function start() {
  const config = loadConfig();
  if (!config) {
    print("  No config found. Running setup first...\n");
    await setup();
    return start();
  }

  // Inject config into env for serve.ts
  process.env.WOLFPACK_DEV_DIR = config.devDir;
  process.env.WOLFPACK_PORT = String(config.port);

  print(dim(WOLF));
  print(bold("  WOLFPACK"));
  print(dim("  The pack is online."));
  print("");
  print(`  Projects: ${dim(config.devDir)}`);
  print(`  Local:    ${dim(`http://localhost:${config.port}/`)}`);
  const url = remoteUrl(config);
  if (url) print(`  Remote:   ${dim(url)}`);
  print("");
  print(dim("  Scan to open on your phone:"));
  print("");
  printQR(url ?? `http://localhost:${config.port}/`);
  print("");

  // Import and run serve
  await import("./serve.js");
}

// ── Service management (launchd on macOS, systemd on Linux) ──

const PLIST_LABEL = "com.wolfpack.server";
const PLIST_PATH = join(
  process.env.HOME ?? "~",
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const SYSTEMD_SERVICE = "wolfpack";
const SYSTEMD_PATH = join(
  process.env.HOME ?? "~",
  ".config",
  "systemd",
  "user",
  `${SYSTEMD_SERVICE}.service`,
);

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function generatePlist(): string {
  const binaryPath = process.execPath;
  const config = loadConfig();
  const env: Record<string, string> = {};
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key>\n      <string>${xmlEsc(v)}</string>`)
    .join("\n");

  const logPath = xmlEsc(join(process.env.HOME ?? "~", ".wolfpack", "wolfpack.log"));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEsc(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
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
  const binaryPath = process.execPath;
  const config = loadConfig();
  const envLines: string[] = [
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin`,
  ];
  if (config?.devDir) envLines.push(`Environment="WOLFPACK_DEV_DIR=${config.devDir}"`);
  if (config?.port) envLines.push(`Environment="WOLFPACK_PORT=${config.port}"`);

  return `[Unit]
Description=Wolfpack AI Agent Bridge
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath}
Restart=always
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

function serviceInstall() {
  const config = loadConfig();
  if (!config) {
    print(red("  Run 'wolfpack setup' first."));
    process.exit(1);
  }

  if (IS_MACOS) {
    const plist = generatePlist();
    mkdirSync(join(process.env.HOME ?? "~", "Library", "LaunchAgents"), {
      recursive: true,
    });
    writeFileSync(PLIST_PATH, plist);

    // Unload first if already loaded
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch {}
    execSync(`launchctl load "${PLIST_PATH}"`);

    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Plist: ${PLIST_PATH}`));
  } else if (IS_LINUX) {
    const unit = generateSystemdUnit();
    mkdirSync(join(process.env.HOME ?? "~", ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(SYSTEMD_PATH, unit);

    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);

    // Enable linger so user services start at boot, not just on login
    try {
      execSync(`sudo loginctl enable-linger ${process.env.USER}`);
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
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch {}
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
  if (IS_MACOS) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`);
    } catch {}
  } else if (IS_LINUX) {
    try {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`);
    } catch {}
  }
  print(green("  Wolfpack service stopped."));
}

function serviceStart() {
  if (IS_MACOS) {
    try {
      execSync(`launchctl load "${PLIST_PATH}"`);
    } catch {}
  } else if (IS_LINUX) {
    try {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    } catch {}
  }
  print(green("  Wolfpack service started."));
}

function serviceStatus() {
  if (IS_MACOS) {
    try {
      const out = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, {
        encoding: "utf-8",
      });
      if (out.includes("PID")) {
        const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
        print(
          green(
            `  Wolfpack is running${pidMatch ? ` (PID ${pidMatch[1]})` : ""}`,
          ),
        );
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
  // Stop and remove launchd service
  serviceUninstall();

  // Remove config dir
  const rmDir = WOLFPACK_DIR;
  try {
    execSync(`rm -rf ${JSON.stringify(rmDir)}`);
  } catch {}

  print("");
  print(green("  Wolfpack uninstalled."));
  print(dim(`  Removed ${rmDir}`));
  print("");
  print(dim("  The wolfpack binary remains at: " + process.execPath));
  print(dim("  Delete it manually if you want a full removal."));
  print("");
}

// ── CLI dispatch ──

const cmd = process.argv[2];
const subcmd = process.argv[3];

if (cmd === "setup") {
  setup();
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
} else {
  start();
}
