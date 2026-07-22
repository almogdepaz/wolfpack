/**
 * Playwright e2e helpers — broker lifecycle.
 *
 * Spawns `wolfpack-broker` on a temp Unix socket and boots a wolfpack server
 * wired to it via BrokerBackend. Exposes `start()` / `teardown()` lifecycle
 * and a `skipIfNoBroker` export for Playwright project-level skip.
 *
 * Socket path note: uses a `/tmp/wp-broker-*` directory with `b.sock` inside rather than os.tmpdir()
 * because macOS tmpdir() expands to `/var/folders/…` which easily exceeds the
 * ~104-char Unix socket path limit. The socket still lives inside a private
 * temp dir because the broker rejects shared parents it cannot chmod to 0700.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrokerTestServer {
  port: number;
  baseUrl: string;
  socketPath: string;
  brokerStderr(): string;
  teardown(): Promise<void>;
}

// ── Binary resolution ─────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..", "..");

function resolveBrokerBin(): string | null {
  const fromEnv = process.env.WOLFPACK_BROKER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    join(ROOT, "broker", "target", "debug", "wolfpack-broker"),
    join(ROOT, "broker", "target", "release", "wolfpack-broker"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export const BROKER_BIN = resolveBrokerBin();

// ── Playwright skip helper ────────────────────────────────────────────────────

/**
 * Use at the top of any broker e2e test file to skip the whole suite when
 * the broker binary is absent:
 *
 *   test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
 */
export const skipIfNoBroker = {
  condition: !BROKER_BIN,
  reason:
    "wolfpack-broker binary not found — run " +
    "`cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first",
} as const;

// ── Internal helpers ──────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${p} to appear`);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start the broker binary and a wolfpack server wired to it.
 *
 * 1. Spawns `wolfpack-broker` on `/tmp/wp-broker-<uuid>.sock`
 * 2. Boots `tests/e2e/test-server-broker.ts` against that socket
 * 3. Resolves once both are ready (wolfpack prints `READY:<port>`)
 *
 * Call `teardown()` in `afterAll` to clean up both processes.
 *
 * Throws if the broker binary is not found — guard with `skipIfNoBroker` first.
 */
export async function start(opts?: {
  /** Extra env vars merged into the wolfpack server process env (not the broker). */
  envOverrides?: Record<string, string>;
}): Promise<BrokerTestServer> {
  if (!BROKER_BIN) {
    throw new Error(skipIfNoBroker.reason);
  }

  const socketDir = mkdtempSync("/tmp/wp-broker-");
  const socketPath = join(socketDir, "b.sock");

  // 1. Spawn broker binary
  let brokerStderr = "";
  const brokerProc: ChildProcess = spawn(BROKER_BIN, [], {
    env: {
      ...process.env,
      WOLFPACK_BROKER_SOCKET: socketPath,
      WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  brokerProc.stderr?.on("data", (chunk: Buffer) => {
    brokerStderr += chunk.toString("utf8");
    if (brokerStderr.length > 64 * 1024) brokerStderr = brokerStderr.slice(-64 * 1024);
  });

  // 2. Wait for the socket file to appear (broker is ready to accept connections)
  await waitForFile(socketPath, 5000);

  // 3. Spawn wolfpack server wired to the broker
  const serverProc: ChildProcess = spawn(
    "bun",
    [join(ROOT, "tests", "e2e", "test-server-broker.ts")],
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WOLFPACK_TEST: "1",
        WOLFPACK_BROKER_SOCKET: socketPath,
        ...(opts?.envOverrides ?? {}),
      },
    },
  );

  // 4. Wait for READY:<port>
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      serverProc.kill();
      reject(new Error("broker test server did not start within 15s"));
    }, 15_000);

    let stdout = "";
    serverProc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });

    serverProc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) process.stderr.write(`[test-server-broker] ${msg}\n`);
    });

    serverProc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProc.on("exit", (code) => {
      if (!stdout.includes("READY:")) {
        clearTimeout(timeout);
        reject(new Error(`test-server-broker exited (code ${code}) before printing READY`));
      }
    });
  });

  // 5. Teardown: kill server first, then broker, then optionally dump stderr
  async function teardown(): Promise<void> {
    try { serverProc.kill("SIGTERM"); } catch { /* swallow */ }
    await wait(200);
    try {
      if (brokerProc.exitCode === null) {
        brokerProc.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => brokerProc.once("exit", () => r())),
          wait(3000),
        ]);
        if (brokerProc.exitCode === null) {
          try { brokerProc.kill("SIGKILL"); } catch { /* swallow */ }
        }
      }
    } catch { /* swallow */ }
    try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (process.env.WOLFPACK_BROKER_DEBUG && brokerStderr) {
      process.stderr.write("[broker stderr]\n" + brokerStderr + "\n");
    }
  }

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    socketPath,
    brokerStderr: () => brokerStderr,
    teardown,
  };
}
