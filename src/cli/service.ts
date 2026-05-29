/**
 * Service management — launchd (macOS) and systemd (Linux).
 */
import { execSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { xmlEsc, systemdEsc } from "../validation.js";
import { createLogger, errMsg } from "../log.js";
import { print, bold, green, red, dim } from "./formatting.js";

const log = createLogger("service");
import {
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  loadConfig,
  ask,
  isPortInUse,
  killPortHolder,
  waitForPortFree,
  type Config,
} from "./config.js";

import pkg from "../../package.json";
const VERSION: string = pkg.version;

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

const BROKER_PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.wolfpack.broker.plist",
);
const BROKER_SYSTEMD_SERVICE = "wolfpack-broker";
const BROKER_SYSTEMD_PATH = join(
  homedir(),
  ".config",
  "systemd",
  "user",
  `${BROKER_SYSTEMD_SERVICE}.service`,
);
const BROKER_SOCKET_PATH = join(WOLFPACK_DIR, "broker.sock");
const BROKER_LOG_PATH = join(WOLFPACK_DIR, "broker.log");

function programArgs(): string[] {
  const exe = process.execPath;
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime && process.argv[1]) {
    return [exe, resolve(process.argv[1])];
  }
  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");
  if (exe !== stableBin && existsSync(exe)) {
    try {
      mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
      copyFileSync(exe, stableBin);
      chmodSync(stableBin, 0o755);
      return [stableBin];
    } catch (e: unknown) {
      log.warn("programArgs: failed to copy binary to stable location", { error: errMsg(e) });
    }
  }
  return [exe];
}

const STABLE_BROKER_PATH = join(WOLFPACK_DIR, "bin", "wolfpack-broker");

/**
 * Finds the wolfpack-broker binary and stages it at
 * `~/.wolfpack/bin/wolfpack-broker`. Returns the absolute path to the
 * staged binary, or null if no source binary could be located.
 *
 * Search order:
 *  1. Already at the stable path → return it.
 *  2. Co-located with the running wolfpack binary (same directory).
 *  3. `broker/target/release/wolfpack-broker` under the cwd (dev tree).
 */
export function brokerProgramPath(): string | null {
  if (existsSync(STABLE_BROKER_PATH)) return STABLE_BROKER_PATH;

  const candidates: string[] = [];
  const exe = process.execPath;
  if (exe && exe !== "/usr/local/bin/bun" && !exe.endsWith("/bun")) {
    // Beside the compiled wolfpack binary
    const dir = exe.substring(0, exe.lastIndexOf("/"));
    if (dir) candidates.push(join(dir, "wolfpack-broker"));
  }
  // Dev tree: cargo build --release output
  candidates.push(resolve(process.cwd(), "broker", "target", "release", "wolfpack-broker"));

  for (const src of candidates) {
    if (!existsSync(src)) continue;
    try {
      mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
      copyFileSync(src, STABLE_BROKER_PATH);
      chmodSync(STABLE_BROKER_PATH, 0o755);
      return STABLE_BROKER_PATH;
    } catch (e: unknown) {
      log.warn("brokerProgramPath: failed to copy", { src, error: errMsg(e) });
    }
  }
  return null;
}

/**
 * Copies the currently-running binary to ~/.wolfpack/bin/wolfpack if it
 * differs from what's already there.  Returns true when the stable binary
 * was actually replaced (i.e. an upgrade happened).
 */
export function updateStableBinary(): boolean {
  const exe = process.execPath;
  if (exe.endsWith("/bun") || exe.endsWith("/bun.exe")) return false;

  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");
  if (exe === stableBin) return false;
  if (!existsSync(exe)) return false;

  try {
    if (existsSync(stableBin)) {
      const a = statSync(exe).size;
      const b = statSync(stableBin).size;
      if (a === b && readFileSync(exe).equals(readFileSync(stableBin))) {
        return false;
      }
    }
    mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
    copyFileSync(exe, stableBin);
    chmodSync(stableBin, 0o755);
    return true;
  } catch (e: unknown) {
    log.warn("failed to update stable binary", { error: errMsg(e) });
    return false;
  }
}

export function renderPlist(config: Config | null, args: string[], logPath: string): string {
  const env: Record<string, string> = { WOLFPACK_SERVICE: "1" };
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key>\n      <string>${xmlEsc(v)}</string>`)
    .join("\n");

  const safeLogPath = xmlEsc(logPath);
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
  <string>${safeLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${safeLogPath}</string>
</dict>
</plist>`;
}

export function generatePlist(): string {
  return renderPlist(
    loadConfig(),
    programArgs(),
    join(homedir(), ".wolfpack", "wolfpack.log"),
  );
}

export function renderSystemdUnit(config: Config | null, args: string[]): string {
  const envLines: string[] = [
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin`,
    `Environment=WOLFPACK_SERVICE=1`,
  ];
  if (config?.devDir) envLines.push(`Environment="WOLFPACK_DEV_DIR=${systemdEsc(config.devDir)}"`);
  if (config?.port) envLines.push(`Environment="WOLFPACK_PORT=${config.port}"`);

  const quotedArgs = args.map(a => `"${systemdEsc(a)}"`).join(" ");
  return `[Unit]
Description=Wolfpack AI Agent Bridge
After=network.target ${BROKER_SYSTEMD_SERVICE}.service
Requires=${BROKER_SYSTEMD_SERVICE}.service

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

export function generateSystemdUnit(): string {
  return renderSystemdUnit(loadConfig(), programArgs());
}

// ── Broker service file renderers ──────────────────────────────────────────
//
// The broker daemon owns all PTY sessions and must run before the wolfpack
// server. macOS uses a separate launchd label; linux uses a systemd unit
// that wolfpack.service requires (`Requires=` ordering).
//
// Service install/uninstall wiring for these files is out of scope for this
// commit — these renderers are exposed so they can be snapshot-tested and
// installed by a future service-install pass.

const BROKER_PLIST_LABEL = "com.wolfpack.broker";

export function renderBrokerPlist(brokerBinPath: string, logPath: string): string {
  const safeLog = xmlEsc(logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEsc(BROKER_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(brokerBinPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${safeLog}</string>
  <key>StandardErrorPath</key>
  <string>${safeLog}</string>
</dict>
</plist>`;
}

export function renderBrokerSystemdUnit(brokerBinPath: string): string {
  return `[Unit]
Description=Wolfpack PTY broker daemon
After=network.target

[Service]
Type=simple
ExecStart="${systemdEsc(brokerBinPath)}"
Restart=always
RestartSec=2
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

// launchd domain target for the current user
const LAUNCHD_DOMAIN = `gui/${process.getuid!()}`;
const LAUNCHD_TARGET = `${LAUNCHD_DOMAIN}/${PLIST_LABEL}`;
const BROKER_LAUNCHD_TARGET = `${LAUNCHD_DOMAIN}/com.wolfpack.broker`;

export interface ServiceActionOptions {
  readonly broker?: boolean;
  readonly skipBrokerSessionWarning?: boolean;
}

function launchdBootout() {
  try {
    execSync(`launchctl bootout ${LAUNCHD_TARGET} 2>/dev/null`);
  } catch {
    // fallback: pre-1.4 versions used deprecated `launchctl load`, which
    // `bootout` can't always remove — try the legacy unload path
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch (e: unknown) {
      log.warn("launchdBootout: legacy unload also failed", { error: errMsg(e) });
    }
  }
}

function launchdBootstrap() {
  execSync(`launchctl bootstrap ${LAUNCHD_DOMAIN} "${PLIST_PATH}"`);
  execSync(`launchctl kickstart ${LAUNCHD_TARGET}`);
}

function launchdBootoutBroker() {
  try { execSync(`launchctl bootout ${BROKER_LAUNCHD_TARGET} 2>/dev/null`); } catch { /* expected when not loaded */ }
}

function launchdBootstrapBroker() {
  execSync(`launchctl bootstrap ${LAUNCHD_DOMAIN} "${BROKER_PLIST_PATH}"`);
  execSync(`launchctl kickstart ${BROKER_LAUNCHD_TARGET}`);
}

/** Try to build the broker from source via cargo if a Cargo.toml is reachable.
 *  Returns the staged binary path on success, null on failure. */
export function ensureBrokerBinary(): string | null {
  const found = brokerProgramPath();
  if (found) return found;

  // Try cargo build from the dev tree as a fallback.
  const manifest = resolve(process.cwd(), "broker", "Cargo.toml");
  if (!existsSync(manifest)) return null;
  try {
    execFileSync("which", ["cargo"], { stdio: "ignore" });
  } catch {
    return null;
  }
  print(dim("  Building wolfpack-broker (cargo build --release)..."));
  try {
    execSync(`cargo build --release --manifest-path "${manifest}" --bin wolfpack-broker`, {
      stdio: "inherit",
    });
  } catch (e: unknown) {
    log.warn("ensureBrokerBinary: cargo build failed", { error: errMsg(e) });
    return null;
  }
  return brokerProgramPath();
}

/** Install the broker as a service (launchd / systemd). Must run before
 *  the wolfpack server is bootstrapped so the socket is ready. */
function brokerServiceInstall(): void {
  const brokerBin = ensureBrokerBinary();
  if (!brokerBin) {
    print(red("  Could not locate wolfpack-broker binary."));
    print(dim("  Expected one of:"));
    print(dim(`    - ${STABLE_BROKER_PATH} (already-installed)`));
    print(dim(`    - co-located with the wolfpack binary`));
    print(dim(`    - ./broker/target/release/wolfpack-broker (dev tree, run \`cargo build --release --manifest-path broker/Cargo.toml\`)`));
    process.exit(1);
  }

  if (IS_MACOS) {
    try {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(BROKER_PLIST_PATH, renderBrokerPlist(brokerBin, BROKER_LOG_PATH));
    } catch (e: unknown) {
      log.error("failed to write broker plist", { error: errMsg(e) });
      print(red(`  Failed to write broker plist: ${errMsg(e)}`));
      process.exit(1);
    }
    launchdBootoutBroker();
    try { launchdBootstrapBroker(); } catch (e: unknown) {
      log.error("broker launchctl bootstrap failed", { error: errMsg(e) });
      print(red(`  Failed to register broker with launchd: ${errMsg(e)}`));
      process.exit(1);
    }
    print(dim(`  Broker plist: ${BROKER_PLIST_PATH}`));
  } else if (IS_LINUX) {
    try {
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
      writeFileSync(BROKER_SYSTEMD_PATH, renderBrokerSystemdUnit(brokerBin));
    } catch (e: unknown) {
      log.error("failed to write broker systemd unit", { error: errMsg(e) });
      print(red(`  Failed to write broker unit: ${errMsg(e)}`));
      process.exit(1);
    }
    try {
      execSync("systemctl --user daemon-reload");
      execSync(`systemctl --user enable ${BROKER_SYSTEMD_SERVICE}`);
      execSync(`systemctl --user start ${BROKER_SYSTEMD_SERVICE}`);
    } catch (e: unknown) {
      log.error("broker systemctl enable/start failed", { error: errMsg(e) });
      print(red(`  Failed to enable/start broker: ${errMsg(e)}`));
      process.exit(1);
    }
    print(dim(`  Broker unit:  ${BROKER_SYSTEMD_PATH}`));
  }
}

function cleanupBrokerSocket(): void {
  try { unlinkSync(BROKER_SOCKET_PATH); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("failed to remove broker socket", { error: errMsg(e) });
  }
}

function brokerServiceStop(): void {
  if (IS_MACOS) {
    launchdBootoutBroker();
  } else if (IS_LINUX) {
    try { execSync(`systemctl --user stop ${BROKER_SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected when not running */ }
  }
  cleanupBrokerSocket();
  print(green("  Wolfpack broker stopped."));
}

function brokerServiceStart(): void {
  if (isBrokerServiceRunning()) {
    print(dim("  Wolfpack broker already running."));
    return;
  }
  brokerServiceInstall();
  print(green("  Wolfpack broker started."));
}

function brokerServiceUninstall(): void {
  brokerServiceStop();
  if (IS_MACOS) {
    try { unlinkSync(BROKER_PLIST_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("failed to remove broker plist", { error: errMsg(e) });
    }
  } else if (IS_LINUX) {
    try { execSync(`systemctl --user disable ${BROKER_SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected when not enabled */ }
    try { unlinkSync(BROKER_SYSTEMD_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("failed to remove broker unit", { error: errMsg(e) });
    }
    try { execSync("systemctl --user daemon-reload"); } catch (e: unknown) {
      log.warn("daemon-reload after broker uninstall failed", { error: errMsg(e) });
    }
  }
}

export function isServiceInstalled(): boolean {
  if (IS_MACOS) return existsSync(PLIST_PATH);
  if (IS_LINUX) return existsSync(SYSTEMD_PATH);
  return false;
}

export function serviceInstall() {
  const config = loadConfig();
  if (!config) {
    print(red("  Run 'wolfpack setup' first."));
    process.exit(1);
  }

  if (isServiceRunning()) {
    serviceStop();
  }
  if (isPortInUse(config.port)) {
    waitForPortFree(config.port);
  }

  // Bootstrap the broker first — wolfpack server fails to start if the
  // broker socket isn't reachable.
  brokerServiceInstall();

  if (IS_MACOS) {
    const plist = generatePlist();
    try {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    } catch (e: unknown) {
      log.error("failed to create LaunchAgents directory", { error: errMsg(e) });
      print(red(`  Failed to create ~/Library/LaunchAgents: ${errMsg(e)}`));
      process.exit(1);
    }
    try {
      writeFileSync(PLIST_PATH, plist);
    } catch (e: unknown) {
      log.error("failed to write plist", { path: PLIST_PATH, error: errMsg(e) });
      print(red(`  Failed to write plist: ${errMsg(e)}`));
      print(dim("  Check permissions on ~/Library/LaunchAgents or run with sudo."));
      process.exit(1);
    }
    launchdBootout();
    try {
      launchdBootstrap();
    } catch (e: unknown) {
      log.error("launchctl bootstrap failed", { error: errMsg(e) });
      print(red(`  Failed to register service with launchd: ${errMsg(e)}`));
      print(dim("  The plist was written but launchctl bootstrap/kickstart failed."));
      print(dim(`  Try manually: launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`));
      process.exit(1);
    }
    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Plist: ${PLIST_PATH}`));
  } else if (IS_LINUX) {
    const unit = generateSystemdUnit();
    try {
      mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    } catch (e: unknown) {
      log.error("failed to create systemd user directory", { error: errMsg(e) });
      print(red(`  Failed to create ~/.config/systemd/user: ${errMsg(e)}`));
      process.exit(1);
    }
    try {
      writeFileSync(SYSTEMD_PATH, unit);
    } catch (e: unknown) {
      log.error("failed to write systemd unit", { path: SYSTEMD_PATH, error: errMsg(e) });
      print(red(`  Failed to write unit file: ${errMsg(e)}`));
      print(dim("  Check permissions on ~/.config/systemd/user/."));
      process.exit(1);
    }
    try {
      execSync("systemctl --user daemon-reload");
    } catch (e: unknown) {
      log.error("systemctl daemon-reload failed", { error: errMsg(e) });
      print(red(`  Failed to reload systemd: ${errMsg(e)}`));
      print(dim("  Is systemd --user running? Check: systemctl --user status"));
      process.exit(1);
    }
    try {
      execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    } catch (e: unknown) {
      log.error("systemctl enable failed", { error: errMsg(e) });
      print(red(`  Failed to enable service: ${errMsg(e)}`));
      process.exit(1);
    }
    try {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    } catch (e: unknown) {
      log.error("systemctl start failed", { error: errMsg(e) });
      print(red(`  Failed to start service: ${errMsg(e)}`));
      print(dim(`  Check logs: journalctl --user -u ${SYSTEMD_SERVICE}`));
      process.exit(1);
    }
    try {
      const user = process.env.USER || "";
      if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
        print(dim("  Note: Could not validate USER for linger. Skipping."));
      } else {
        execFileSync("sudo", ["loginctl", "enable-linger", user]);
      }
    } catch (e: unknown) {
      log.warn("failed to enable linger", { error: errMsg(e) });
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

export function serviceUninstall() {
  if (IS_MACOS) {
    launchdBootout();
    try { unlinkSync(PLIST_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("serviceUninstall: failed to remove plist", { error: errMsg(e) });
    }
  } else if (IS_LINUX) {
    try { execSync(`systemctl --user stop ${SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected: exits non-zero when service not running */ }
    try { execSync(`systemctl --user disable ${SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected: exits non-zero when already disabled */ }
    try { unlinkSync(SYSTEMD_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("serviceUninstall: failed to remove unit file", { error: errMsg(e) });
    }
    try { execSync("systemctl --user daemon-reload"); } catch (e: unknown) {
      log.warn("serviceUninstall: failed to reload systemd daemon", { error: errMsg(e) });
    }
  }
  // Tear down the broker after the wolfpack server (server depends on it).
  brokerServiceUninstall();
  print(green("  Wolfpack service removed."));
}

export function serviceStop(options: ServiceActionOptions = {}): boolean {
  const config = loadConfig();
  const stopBroker = options.broker ?? (ask("  Stop broker too? This kills broker-owned sessions. (y/n) ").toLowerCase() === "y");

  // Warn about active sessions before stopping
  if (!options.skipBrokerSessionWarning && config && isPortInUse(config.port)) {
    try {
      const res = execFileSync(
        "curl", ["-s", "--max-time", "3", `http://127.0.0.1:${config.port}/api/backend`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const data = JSON.parse(res);
      if (!data?.counts) {
        // /api/backend returned a non-count payload — likely 401 when JWT auth is configured.
        // Surface the warning anyway: stopping wolfpack won't kill broker sessions, but the user
        // should still confirm before tearing down the server.
        print(dim("\n  Session count unavailable (server may require auth)."));
        const answer = ask("  Continue? (y/n) ");
        if (answer.toLowerCase() !== "y") {
          print(dim("  Aborted."));
          return false;
        }
      } else {
        const { broker = 0 } = data.counts;
        if (broker > 0) {
          const consequence = stopBroker ? "will be terminated with the broker daemon" : "will persist (broker daemon is independent)";
          print(dim(`\n  ${broker} broker session${broker > 1 ? "s" : ""} ${consequence}.`));
          const answer = ask("  Continue? (y/n) ");
          if (answer.toLowerCase() !== "y") {
            print(dim("  Aborted."));
            return false;
          }
        }
      }
    } catch { /* server unreachable or parse error — proceed with stop */ }
  }

  try {
    if (IS_MACOS) {
      launchdBootout();
    } else if (IS_LINUX) {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service stopped."));
  } catch (e: unknown) {
    log.error("failed to stop service", { error: errMsg(e) });
    print(red("  Failed to stop service."));
    return false;
  }
  if (config && isPortInUse(config.port)) {
    killPortHolder(config.port);
    waitForPortFree(config.port, 5000);
  }
  if (stopBroker) brokerServiceStop();
  return true;
}

export function serviceStart(_options: ServiceActionOptions = {}) {
  if (!isBrokerServiceRunning()) brokerServiceStart();
  const config = loadConfig();
  if (config && isPortInUse(config.port)) {
    killPortHolder(config.port);
    waitForPortFree(config.port, 5000);
  }
  try {
    if (IS_MACOS) {
      launchdBootstrap();
    } else if (IS_LINUX) {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service started."));
  } catch (e: unknown) {
    log.error("failed to start service", { error: errMsg(e) });
    print(red("  Failed to start service."));
  }
}

export function serviceRestart(options: ServiceActionOptions = {}) {
  const restartBroker = options.broker ?? (ask("  Restart broker too? This kills broker-owned sessions. (y/n) ").toLowerCase() === "y");
  if (!serviceStop({ broker: restartBroker })) return;
  serviceStart({ broker: restartBroker });
}

export function isServiceRunning(): boolean {
  try {
    if (IS_MACOS) {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, { encoding: "utf-8" });
      return /pid\s*=\s*\d+/i.test(out);
    } else if (IS_LINUX) {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, { encoding: "utf-8" }).trim();
      return out === "active";
    }
  } catch { /* expected: command exits non-zero when service inactive */ }
  return false;
}

export function isBrokerServiceRunning(): boolean {
  try {
    if (IS_MACOS) {
      const out = execSync(`launchctl print ${BROKER_LAUNCHD_TARGET} 2>&1`, { encoding: "utf-8" });
      return /pid\s*=\s*\d+/i.test(out);
    } else if (IS_LINUX) {
      const out = execSync(`systemctl --user is-active ${BROKER_SYSTEMD_SERVICE} 2>&1`, { encoding: "utf-8" }).trim();
      return out === "active";
    }
  } catch { /* expected: command exits non-zero when broker is inactive */ }
  return false;
}

function printBrokerStatus(): void {
  if (isBrokerServiceRunning()) {
    print(green("  Broker is running."));
    return;
  }
  if (IS_MACOS && existsSync(BROKER_PLIST_PATH)) {
    print(dim("  Broker service is installed but not running."));
  } else if (IS_LINUX && existsSync(BROKER_SYSTEMD_PATH)) {
    print(dim("  Broker service is installed but not running."));
  } else {
    print(dim("  Broker service is not installed."));
  }
}

export function serviceStatus() {
  print(dim(`  Version: ${VERSION}`));
  if (IS_MACOS) {
    try {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, { encoding: "utf-8" });
      const pidMatch = out.match(/pid\s*=\s*(\d+)/i);
      if (pidMatch) {
        print(green(`  Wolfpack is running (PID ${pidMatch[1]})`));
      } else {
        print(dim("  Wolfpack service is loaded but not running."));
      }
    } catch { /* expected: launchctl print exits non-zero when service not loaded */
      if (existsSync(PLIST_PATH)) {
        print(dim("  Wolfpack service is installed but not loaded."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else if (IS_LINUX) {
    try {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, { encoding: "utf-8" }).trim();
      if (out === "active") {
        const pidOut = execSync(
          `systemctl --user show ${SYSTEMD_SERVICE} --property=MainPID --value`,
          { encoding: "utf-8" },
        ).trim();
        print(green(`  Wolfpack is running (PID ${pidOut})`));
      } else {
        print(dim(`  Wolfpack service status: ${out}`));
      }
    } catch { /* expected: systemctl exits non-zero when service not active */
      if (existsSync(SYSTEMD_PATH)) {
        print(dim("  Wolfpack service is installed but not running."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else {
    print(dim("  Service status not supported on this platform."));
  }
  printBrokerStatus();
}

export function uninstall() {
  serviceUninstall();
  try { rmSync(WOLFPACK_DIR, { recursive: true, force: true }); } catch (e: unknown) {
    log.warn("uninstall: failed to remove wolfpack dir", { path: WOLFPACK_DIR, error: errMsg(e) });
  }
  print("");
  print(green("  Wolfpack uninstalled."));
  print(dim(`  Removed ${WOLFPACK_DIR}`));
  print("");
  print(dim("  The wolfpack binary remains at: " + process.execPath));
  print(dim("  Delete it manually if you want a full removal."));
  print("");
}
