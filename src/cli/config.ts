/**
 * Config type, load/save, port utilities, ask() helper.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readSync,
} from "node:fs";
import { IS_MACOS } from "../config.js";
export * from "../config.js";
import { isValidPort } from "../validation.js";
import { print, dim, yellow } from "./formatting.js";

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
    const p = port;
    if (!isValidPort(p)) return false;
    if (IS_MACOS) {
      // Match Linux's TCP-listener semantics, not UDP or a client's endpoint.
      const out = execFileSync("lsof", ["-nP", "-a", `-iTCP:${p}`, "-sTCP:LISTEN", "-t"], {
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
    const p = port;
    if (!isValidPort(p)) return false;
    let pid: number | null = null;
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-nP", "-a", `-iTCP:${p}`, "-sTCP:LISTEN", "-t"], {
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
