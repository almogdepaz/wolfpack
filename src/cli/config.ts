/**
 * Config type, load/save, port utilities, ask() helper.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { isValidPort } from "../validation.js";
import { print, dim, yellow } from "./formatting.js";

export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

export const WOLFPACK_DIR = join(homedir(), ".wolfpack");
export const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

export interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

export let hasTTY = true;

export function ask(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch { /* expected: no tty available in non-interactive mode */
    hasTTY = false;
    return "";
  }
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, null);
  } finally {
    closeSync(fd);
  }
  return buf.subarray(0, n).toString("utf-8").trim();
}

export function parseConfig(raw: unknown): Config | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const devDir = typeof candidate.devDir === "string" ? candidate.devDir.trim() : "";
  const port = Math.floor(Number(candidate.port));
  if (!devDir || !isValidPort(port)) return null;
  const tailscaleHostname =
    typeof candidate.tailscaleHostname === "string"
      ? candidate.tailscaleHostname.trim() || undefined
      : undefined;
  return { devDir, port, tailscaleHostname };
}

export function loadConfigFromText(text: string): Config | null {
  try {
    return parseConfig(JSON.parse(text));
  } catch { /* expected: malformed or empty config text */
    return null;
  }
}

export function loadConfig(): Config | null {
  try {
    return loadConfigFromText(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { /* expected: config file doesn't exist yet */
    return null;
  }
}

export function saveConfig(c: Config) {
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Check if a process command string belongs to wolfpack. */
export function isWolfpackProcess(comm: string): boolean {
  return comm.includes("wolfpack");
}

/** Prefer full args when binary name alone is not descriptive. */
export function resolveProcessCommandForValidation(comm: string, args: string): string {
  if (isWolfpackProcess(comm)) return comm;
  return args || comm;
}

export function isPortInUse(port: number): boolean {
  try {
    const p = Math.floor(Number(port));
    if (!isValidPort(p)) return false;
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-i", `:${p}`, "-t"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0;
    } else {
      const out = execFileSync("ss", ["-tlnp", "sport", "=", `:${p}`], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.split("\n").length > 1;
    }
  } catch { /* expected: lsof/ss exit non-zero when port is free or command missing */
    return false;
  }
}

export function killPortHolder(port: number): boolean {
  try {
    const p = Math.floor(Number(port));
    if (!isValidPort(p)) return false;
    let pid: number | null = null;
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-i", `:${p}`, "-t"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      pid = out ? Number(out.split("\n")[0]) : null;
    } else {
      const out = execFileSync("ss", ["-tlnp", "sport", "=", `:${p}`], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const m = out.match(/pid=(\d+)/);
      pid = m ? Number(m[1]) : null;
    }
    if (pid && pid > 1) {
      try {
        const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
          encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        let args = "";
        if (!isWolfpackProcess(comm)) {
          args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        }
        const processCmd = resolveProcessCommandForValidation(comm, args);
        if (!isWolfpackProcess(processCmd)) {
          print(dim(`  Port ${p} held by non-wolfpack process (PID ${pid}): ${processCmd}`));
          return false;
        }
      } catch {
        // process exited between lsof and ps lookup — nothing to kill
        return false;
      }
      process.kill(pid, "SIGTERM");
      print(dim(`  Killed stale process (PID ${pid}) on port ${p}`));
      return true;
    }
  } catch { /* expected: lsof exits non-zero when port is free */ }
  return false;
}

export function waitForPortFree(port: number, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortInUse(port)) return;
    sleepSync(500);
  }
  print(yellow(`  Warning: port ${port} still in use after ${timeoutMs / 1000}s`));
}

export function remoteUrl(config: Config): string | null {
  if (!config.tailscaleHostname) return null;
  return `https://${config.tailscaleHostname}`;
}

const TAILSCALE_MAC_CLI =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Find tailscale binary — checks PATH first, then macOS app bundle. */
export function tailscaleBin(): string | null {
  try {
    execFileSync("tailscale", ["version"], { stdio: "ignore" });
    return "tailscale";
  } catch { /* probe: tailscale not in PATH */ }
  if (IS_MACOS) {
    try {
      execFileSync(TAILSCALE_MAC_CLI, ["version"], { stdio: "ignore" });
      return TAILSCALE_MAC_CLI;
    } catch { /* probe: Tailscale.app CLI not found */ }
  }
  return null;
}
