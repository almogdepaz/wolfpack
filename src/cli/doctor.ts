/**
 * `wolfpack doctor` — system health check with optional --fix.
 */
import { execFileSync, execSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import * as net from "node:net";
import { createLogger, errMsg } from "../log.js";
import { print, bold, green, red, dim, yellow } from "./formatting.js";

const log = createLogger("doctor");
import {
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  loadConfig,
  isPortInUse,
  killPortHolder,
  tailscaleBin,
} from "./config.js";
import {
  isServiceInstalled,
  isServiceRunning,
  serviceStart,
  updateStableBinary,
} from "./service.js";

export interface CheckResult {
  name: string;
  group: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  fixHint?: string;
  fix?: () => void;
}

type CheckFn = () => CheckResult[] | Promise<CheckResult[]>;

// ---------------------------------------------------------------------------
// Check group 1: Dependencies
// ---------------------------------------------------------------------------

function checkDeps(): CheckResult[] {
  const results: CheckResult[] = [];

  // tailscale
  const tsBin = tailscaleBin();
  if (tsBin) {
    try {
      const ver = execFileSync(tsBin, ["version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split("\n")[0];
      results.push({ name: "tailscale", group: "Dependencies", status: "pass", detail: ver });
    } catch {
      results.push({ name: "tailscale", group: "Dependencies", status: "warn", detail: "installed (version unreadable)" });
    }

    // tailscale connected?
    try {
      const status = execFileSync(
        IS_LINUX ? "sudo" : tsBin,
        IS_LINUX ? [tsBin, "status", "--self", "--json"] : ["status", "--self", "--json"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const parsed = JSON.parse(status);
      const hostname = parsed.Self?.DNSName?.replace(/\.$/, "");
      if (hostname) {
        results.push({ name: "tailscale connected", group: "Dependencies", status: "pass", detail: hostname });
      } else {
        results.push({
          name: "tailscale connected", group: "Dependencies", status: "warn",
          detail: "not connected", fixHint: "tailscale up",
        });
      }
    } catch {
      results.push({
        name: "tailscale connected", group: "Dependencies", status: "warn",
        detail: "unable to query status", fixHint: "tailscale up",
      });
    }
  } else {
    results.push({
      name: "tailscale", group: "Dependencies", status: "fail", detail: "not found",
      fixHint: IS_MACOS ? "brew install --cask tailscale" : "curl -fsSL https://tailscale.com/install.sh | sh",
    });
  }

  // SHELL
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) {
    results.push({ name: "shell", group: "Dependencies", status: "pass", detail: shell });
  } else {
    results.push({
      name: "shell", group: "Dependencies", status: "warn",
      detail: shell ? `${shell} (not found)` : "SHELL not set",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 2: Config
// ---------------------------------------------------------------------------

function checkConfig(): CheckResult[] {
  const results: CheckResult[] = [];

  // ~/.wolfpack/ exists
  if (existsSync(WOLFPACK_DIR)) {
    results.push({ name: "~/.wolfpack/", group: "Config", status: "pass", detail: "exists" });
  } else {
    results.push({
      name: "~/.wolfpack/", group: "Config", status: "fail", detail: "missing",
      fixHint: "wolfpack setup",
      fix: () => mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 }),
    });
  }

  // config.json
  const config = loadConfig();
  if (config) {
    results.push({
      name: "config.json", group: "Config", status: "pass",
      detail: `port=${config.port}, devDir=${config.devDir}`,
    });
  } else {
    results.push({
      name: "config.json", group: "Config", status: "fail",
      detail: existsSync(join(WOLFPACK_DIR, "config.json")) ? "parse error" : "missing",
      fixHint: "wolfpack setup",
    });
    return results; // can't check devDir without config
  }

  // devDir
  if (existsSync(config.devDir)) {
    try {
      accessSync(config.devDir, fsConstants.R_OK);
      results.push({ name: "devDir", group: "Config", status: "pass", detail: config.devDir });
    } catch {
      results.push({
        name: "devDir", group: "Config", status: "fail",
        detail: `${config.devDir} (not readable)`,
      });
    }
  } else {
    results.push({
      name: "devDir", group: "Config", status: "fail",
      detail: `${config.devDir} (missing)`,
      fix: () => mkdirSync(config.devDir, { recursive: true }),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 3: Service
// ---------------------------------------------------------------------------

function checkService(): CheckResult[] {
  const results: CheckResult[] = [];
  const config = loadConfig();

  // installed
  if (isServiceInstalled()) {
    results.push({ name: "service installed", group: "Service", status: "pass", detail: IS_MACOS ? "launchd" : "systemd" });
  } else {
    results.push({
      name: "service installed", group: "Service", status: "fail",
      detail: "not installed", fixHint: "wolfpack service install",
    });
    return results;
  }

  // running
  if (isServiceRunning()) {
    results.push({ name: "service running", group: "Service", status: "pass", detail: "active" });
  } else {
    results.push({
      name: "service running", group: "Service", status: "fail",
      detail: "not running",
      fix: () => serviceStart(),
    });
  }

  // port ownership
  if (config) {
    if (isPortInUse(config.port)) {
      if (isServiceRunning()) {
        results.push({ name: `port ${config.port}`, group: "Service", status: "pass", detail: "in use, service active" });
      } else {
        results.push({
          name: `port ${config.port}`, group: "Service", status: "fail",
          detail: "held by another process",
          fix: () => killPortHolder(config.port),
        });
      }
    } else if (isServiceRunning()) {
      results.push({
        name: `port ${config.port}`, group: "Service", status: "warn",
        detail: "service running but port is free (may still be starting)",
      });
    } else {
      results.push({
        name: `port ${config.port}`, group: "Service", status: "warn",
        detail: "port free (service not running)",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 4: Connectivity
// ---------------------------------------------------------------------------

async function checkConnectivity(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const config = loadConfig();
  if (!config) return results;

  // localhost
  try {
    const resp = execFileSync(
      "curl", ["-sf", "--max-time", "3", `http://localhost:${config.port}/api/info`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(resp);
    results.push({
      name: "localhost", group: "Connectivity", status: "pass",
      detail: `v${parsed.version || "?"}`,
    });
  } catch {
    results.push({
      name: "localhost", group: "Connectivity", status: "fail",
      detail: `localhost:${config.port} not responding`,
    });
  }

  // tailscale hostname
  if (config.tailscaleHostname) {
    try {
      await dnsLookup(config.tailscaleHostname);
      results.push({
        name: "tailscale hostname", group: "Connectivity", status: "pass",
        detail: config.tailscaleHostname,
      });
    } catch {
      results.push({
        name: "tailscale hostname", group: "Connectivity", status: "warn",
        detail: `${config.tailscaleHostname} (doesn't resolve)`,
        fixHint: "tailscale up",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 5: Binary
// ---------------------------------------------------------------------------

function checkBinary(): CheckResult[] {
  const results: CheckResult[] = [];
  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");

  if (existsSync(stableBin)) {
    const size = statSync(stableBin).size;
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    results.push({ name: "binary", group: "Binary", status: "pass", detail: `${sizeMB}MB` });
  } else {
    results.push({
      name: "binary", group: "Binary", status: "fail", detail: "missing",
      fix: () => {
        const replaced = updateStableBinary();
        if (!replaced) {
          throw new Error("cannot copy binary — rebuild first: bun run scripts/build.ts");
        }
      },
    });
    return results;
  }

  // executable
  try {
    accessSync(stableBin, fsConstants.X_OK);
    results.push({ name: "binary executable", group: "Binary", status: "pass", detail: "yes" });
  } catch {
    results.push({
      name: "binary executable", group: "Binary", status: "fail", detail: "not executable",
      fix: () => chmodSync(stableBin, 0o755),
    });
  }

  // codesign (macOS)
  if (IS_MACOS) {
    try {
      execFileSync("codesign", ["-v", stableBin], { stdio: "ignore" });
      results.push({ name: "codesign", group: "Binary", status: "pass", detail: "valid" });
    } catch {
      results.push({
        name: "codesign", group: "Binary", status: "fail", detail: "invalid or unsigned",
        fix: () => execFileSync("codesign", ["-f", "-s", "-", stableBin], { stdio: "ignore" }),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 6: Broker (PTY daemon)
// ---------------------------------------------------------------------------

async function checkBroker(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Binary location: ~/.wolfpack/bin/wolfpack-broker (preferred) or co-located
  // with the main binary.
  const candidates = [
    join(WOLFPACK_DIR, "bin", "wolfpack-broker"),
    join(WOLFPACK_DIR, "wolfpack-broker"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    results.push({
      name: "broker binary", group: "Broker", status: "pass", detail: found,
    });
  } else {
    results.push({
      name: "broker binary", group: "Broker", status: "fail",
      detail: "not found in ~/.wolfpack/bin",
      fixHint: "bun run scripts/build.ts (requires rust toolchain)",
    });
  }

  // Socket: open it, send list_sessions, expect status === "ok" within 1s.
  const socketPath = join(WOLFPACK_DIR, "broker.sock");
  if (!existsSync(socketPath)) {
    const fix = found ? () => kickstartBroker() : undefined;
    results.push({
      name: "broker socket", group: "Broker",
      status: found ? "fail" : "warn",
      detail: found ? "binary present but no socket — daemon not running" : "no socket — daemon not running",
      fixHint: found ? (IS_MACOS ? "launchctl kickstart gui/$(id -u)/com.wolfpack.broker" : "systemctl --user start wolfpack-broker") : undefined,
      fix,
    });
    return results;
  }

  // Probe handshake.
  const handshake = await brokerHandshake(socketPath, 1000);
  if (handshake.ok) {
    results.push({
      name: "broker handshake", group: "Broker", status: "pass",
      detail: `list_sessions ok (${handshake.elapsedMs}ms)`,
    });
  } else {
    results.push({
      name: "broker handshake", group: "Broker", status: "fail",
      detail: handshake.reason ?? "no response",
      fixHint: IS_MACOS ? "launchctl kickstart gui/$(id -u)/com.wolfpack.broker" : "systemctl --user restart wolfpack-broker",
      fix: found ? () => kickstartBroker() : undefined,
    });
  }

  return results;
}

/** Speak the broker's framed-JSON RPC just enough to verify list_sessions
 *  returns `{ status: "ok" }`. Wire format mirrors src/broker/codec.ts:
 *  `[1 byte kind][4 bytes BE length][payload]`. CONTROL_REQUEST kind = 0x01,
 *  CONTROL_RESPONSE kind = 0x02. */
function brokerHandshake(socketPath: string, timeoutMs: number): Promise<{ ok: boolean; elapsedMs: number; reason?: string }> {
  return new Promise((resolve) => {
    const FRAME_KIND_CONTROL_REQUEST = 0x01;
    const FRAME_KIND_CONTROL_RESPONSE = 0x02;
    const start = Date.now();
    const sock = net.createConnection(socketPath);
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (ok: boolean, reason?: string) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e: unknown) { log.debug("broker probe destroy failed", { error: errMsg(e) }); }
      resolve({ ok, elapsedMs: Date.now() - start, reason });
    };
    const timer = setTimeout(() => finish(false, `timed out after ${timeoutMs}ms`), timeoutMs);
    sock.once("error", (e) => { clearTimeout(timer); finish(false, errMsg(e)); });
    sock.once("connect", () => {
      const payload = JSON.stringify({ id: 1, method: "list_sessions", params: {} });
      const body = Buffer.from(payload, "utf-8");
      const frame = Buffer.alloc(5 + body.length);
      frame[0] = FRAME_KIND_CONTROL_REQUEST;
      frame.writeUInt32BE(body.length, 1);
      body.copy(frame, 5);
      sock.write(frame);
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Frame: kind(1) + len(4) + payload(len). Read frames until we see a
      // CONTROL_RESPONSE (skip async events that may interleave).
      while (buf.length >= 5) {
        const kind = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        const payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (kind !== FRAME_KIND_CONTROL_RESPONSE) continue;
        try {
          const msg = JSON.parse(payload.toString("utf-8"));
          clearTimeout(timer);
          if (msg?.status === "ok") finish(true);
          else finish(false, `broker replied status=${msg?.status}`);
        } catch (e: unknown) {
          clearTimeout(timer);
          finish(false, `parse error: ${errMsg(e)}`);
        }
        return;
      }
    });
  });
}

function kickstartBroker(): void {
  if (IS_MACOS) {
    execSync(`launchctl kickstart gui/$(id -u)/com.wolfpack.broker`);
  } else if (IS_LINUX) {
    execSync(`systemctl --user start wolfpack-broker`);
  }
}

// ---------------------------------------------------------------------------
// Check group 7: Environment
// ---------------------------------------------------------------------------

function checkEnvironment(): CheckResult[] {
  const results: CheckResult[] = [];
  const pathDirs = (process.env.PATH || "").split(":");

  const expectedDirs = IS_MACOS
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : ["/usr/local/bin"];

  for (const dir of expectedDirs) {
    if (pathDirs.includes(dir)) {
      results.push({ name: `PATH includes ${dir}`, group: "Environment", status: "pass", detail: "yes" });
    } else {
      results.push({ name: `PATH includes ${dir}`, group: "Environment", status: "warn", detail: "missing" });
    }
  }

  if (process.env.HOME) {
    results.push({ name: "HOME", group: "Environment", status: "pass", detail: process.env.HOME });
  } else {
    results.push({ name: "HOME", group: "Environment", status: "warn", detail: "not set" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 8: Logs
// ---------------------------------------------------------------------------

function checkLogs(): CheckResult[] {
  const results: CheckResult[] = [];
  const logPath = join(WOLFPACK_DIR, "wolfpack.log");

  if (!existsSync(logPath)) {
    results.push({ name: "wolfpack.log", group: "Logs", status: "pass", detail: "not created yet" });
    return results;
  }

  const stat = statSync(logPath);
  const sizeKB = (stat.size / 1024).toFixed(0);
  const agoMs = Date.now() - stat.mtimeMs;
  const ago = agoMs < 60000 ? `${Math.round(agoMs / 1000)}s ago`
    : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago`
    : `${Math.round(agoMs / 3600000)}h ago`;
  results.push({ name: "wolfpack.log", group: "Logs", status: "pass", detail: `${sizeKB}KB, modified ${ago}` });

  // recent errors — read only the tail to avoid loading huge log files
  try {
    const tail = execFileSync("tail", ["-n", "100", logPath], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    const errorLines = tail.filter(l => /\b(error|fatal|crash|SIGKILL|panic)\b/i.test(l));
    if (errorLines.length === 0) {
      results.push({ name: "recent errors", group: "Logs", status: "pass", detail: "none" });
    } else {
      const last = errorLines.slice(-3).map(l => l.trim().slice(0, 100));
      results.push({
        name: "recent errors", group: "Logs", status: "warn",
        detail: `${errorLines.length} error(s) in last 100 lines`,
      });
      for (const line of last) {
        results.push({ name: "", group: "Logs", status: "warn", detail: line });
      }
    }
  } catch {
    results.push({ name: "recent errors", group: "Logs", status: "warn", detail: "unable to read log" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<CheckResult["status"], string> = {
  pass: green("✓"),
  fail: red("✗"),
  warn: yellow("⚠"),
};

function printResults(results: CheckResult[]): { pass: number; fail: number; warn: number } {
  const counts = { pass: 0, fail: 0, warn: 0 };
  let currentGroup = "";

  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      print("");
      print(bold(`  ${currentGroup}`));
    }
    counts[r.status]++;
    const icon = STATUS_ICONS[r.status];
    if (r.name) {
      print(`    ${icon} ${r.name}${r.detail ? dim(` — ${r.detail}`) : ""}`);
    } else {
      // continuation line (e.g. error log excerpts)
      print(`      ${dim(r.detail)}`);
    }
    if (r.status === "fail" && r.fixHint) {
      print(dim(`      → ${r.fixHint}`));
    }
  }

  return counts;
}

async function runCheckGroups(groups: CheckFn[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const group of groups) {
    results.push(...await group());
  }
  return results;
}

/** Run fix functions on failed results. Returns count of fix attempts. */
export function applyFixes(results: CheckResult[]): number {
  const fixable = results.filter(r => r.status === "fail" && r.fix);
  if (fixable.length === 0) return 0;
  print(bold("\n  Attempting fixes..."));
  for (const r of fixable) {
    try {
      r.fix!();
      print(`    ${green("✓")} fixed: ${r.name}`);
    } catch (e) {
      print(`    ${red("✗")} fix failed: ${r.name} — ${e instanceof Error ? e.message : e}`);
    }
  }
  return fixable.length;
}

export async function doctor({ fix: doFix = process.argv.includes("--fix") } = {}) {

  const checkGroups: CheckFn[] = [
    checkDeps,
    checkConfig,
    checkService,
    checkConnectivity,
    checkBinary,
    checkBroker,
    checkEnvironment,
    checkLogs,
  ];

  let allResults = await runCheckGroups(checkGroups);

  // --fix: attempt fixes then re-run
  if (doFix && applyFixes(allResults) > 0) {
    allResults = await runCheckGroups(checkGroups);
  }

  const counts = printResults(allResults);
  const total = counts.pass + counts.fail + counts.warn;

  print("");
  if (counts.fail === 0) {
    print(green(`  Result: ${counts.pass}/${total} passed`) +
      (counts.warn > 0 ? yellow(`, ${counts.warn} warning(s)`) : ""));
  } else {
    print(red(`  Result: ${counts.fail} failed`) +
      `, ${counts.pass} passed` +
      (counts.warn > 0 ? yellow(`, ${counts.warn} warning(s)`) : ""));
    if (!doFix) {
      const fixableCount = allResults.filter(r => r.status === "fail" && r.fix).length;
      if (fixableCount > 0) {
        print(dim(`  Run ${bold("wolfpack doctor --fix")} to auto-fix ${fixableCount} issue(s).`));
      }
    }
  }
  print("");

  return counts.fail > 0 ? 1 : 0;
}
