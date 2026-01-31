#!/usr/bin/env npx tsx
import { execSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { printQR } from "./qr.js";

const WOLFPACK_DIR = join(process.env.HOME ?? "~", ".wolfpack");
const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

  const hasNode = check("Node.js", "node --version");
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
  if (!hasNode) missing.push("node");
  if (!hasTmux) missing.push("tmux");
  if (!hasTailscale) missing.push("tailscale");

  if (missing.length > 0) {
    try {
      execSync("brew --version", { stdio: "ignore" });
    } catch {
      print(red("  Homebrew is required to install missing dependencies."));
      print(dim("  Install from https://brew.sh"));
      process.exit(1);
    }

    print(`  Will install: ${bold(missing.join(", "))}`);
    const proceed = await ask("  Proceed? (y/n) ");
    if (proceed.toLowerCase() !== "y") {
      print(red("  Aborted."));
      process.exit(1);
    }

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

    // Verify
    print("");
    let verifyFail = false;
    for (const pkg of missing) {
      if (pkg === "tailscale") {
        if (tailscaleBin()) {
          print(`  ${green("✓")} Tailscale installed`);
          print(dim("  Open Tailscale.app and sign in to enable remote access."));
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
  if (hasTailscale) {
    try {
      const status = execSync(`${tsBin} status --self --json`, {
        encoding: "utf-8",
      });
      const parsed = JSON.parse(status);
      tailscaleHostname = parsed.Self?.DNSName?.replace(/\.$/, "");
    } catch {}

    if (tailscaleHostname) {
      print(dim(`  Detected Tailscale hostname: ${tailscaleHostname}`));
    }

    // Setup tailscale serve
    if (tailscaleHostname) {
      try {
        execSync(
          `${tsBin} serve --bg ${port}`,
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

// ── Launch agent (launchd) ──

const PLIST_LABEL = "com.wolfpack.server";
const PLIST_PATH = join(
  process.env.HOME ?? "~",
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);

function generatePlist(): string {
  const nodePath = process.execPath;
  const tsxPath = join(import.meta.dirname, "node_modules", ".bin", "tsx");
  const servePath = join(import.meta.dirname, "serve.ts");
  const config = loadConfig();
  const env: Record<string, string> = {};
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${tsxPath}</string>
    <string>${servePath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${join(nodePath, "..")}:/usr/local/bin:/usr/bin:/bin</string>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(process.env.HOME ?? "~", ".wolfpack", "wolfpack.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(process.env.HOME ?? "~", ".wolfpack", "wolfpack.log")}</string>
</dict>
</plist>`;
}

function serviceInstall() {
  const config = loadConfig();
  if (!config) {
    print(red("  Run 'wolfpack setup' first."));
    process.exit(1);
  }

  const plist = generatePlist();
  mkdirSync(join(process.env.HOME ?? "~", "Library", "LaunchAgents"), {
    recursive: true,
  });
  writeFileSync(PLIST_PATH, plist);

  // Unload first if already loaded
  try {
    execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`);
  } catch {}
  execSync(`launchctl load ${PLIST_PATH}`);

  print("");
  print(green("  Wolfpack service installed and started."));
  print(dim(`  Plist: ${PLIST_PATH}`));
  print(dim(`  Log:   ~/.wolfpack/wolfpack.log`));
  print("");
  print("  Wolfpack will now start automatically on login.");
  print(`  Use ${bold("wolfpack service stop")} to stop.`);
  print(`  Use ${bold("wolfpack service uninstall")} to remove.`);
  print("");
}

function serviceUninstall() {
  try {
    execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`);
  } catch {}
  try {
    unlinkSync(PLIST_PATH);
  } catch {}
  print(green("  Wolfpack service removed."));
}

function serviceStop() {
  try {
    execSync(`launchctl unload ${PLIST_PATH}`);
  } catch {}
  print(green("  Wolfpack service stopped."));
}

function serviceStart() {
  try {
    execSync(`launchctl load ${PLIST_PATH}`);
  } catch {}
  print(green("  Wolfpack service started."));
}

function serviceStatus() {
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
}

function uninstall() {
  // Stop and remove launchd service
  serviceUninstall();

  // Remove npm global link
  try {
    execSync("npm unlink -g wolfpack 2>/dev/null");
  } catch {}

  // Remove config dir
  const rmDir = WOLFPACK_DIR;
  try {
    execSync(`rm -rf ${JSON.stringify(rmDir)}`);
  } catch {}

  print("");
  print(green("  Wolfpack uninstalled."));
  print(dim(`  Removed ${rmDir}`));
  print(dim("  Removed global 'wolfpack' command"));
  print("");
  print(dim("  The app source remains where you cloned it."));
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
