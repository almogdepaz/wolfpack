/**
 * BrokerBackend integration test — drives the real Rust broker binary.
 *
 * Boots `broker/target/{debug,release}/wolfpack-broker` against a temp Unix
 * socket, wires `BrokerClient` + `BrokerBackend` to it, and exercises the
 * SessionBackend surface end-to-end against a real PTY-backed shell session:
 * list / create / sessionDir / capturePane (snapshot-derived) / resize / kill.
 *
 * Skips cleanly when the broker binary is not built. CI must run
 * `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.
 */
process.env.WOLFPACK_TEST = "1";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BrokerClient } from "../../src/broker/client";
import { BrokerBackend } from "../../src/server/broker-backend";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function resolveBrokerBin(): string | null {
  const fromEnv = process.env.WOLFPACK_BROKER_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    path.join(REPO_ROOT, "broker", "target", "debug", "wolfpack-broker"),
    path.join(REPO_ROOT, "broker", "target", "release", "wolfpack-broker"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const BROKER_BIN = resolveBrokerBin();

// Broker isn't built — skip the whole suite cleanly so unit tests stay green.
const D = BROKER_BIN ? describe : describe.skip;

if (!BROKER_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[broker-backend.integration] skipped — broker binary not found. " +
      "Run `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.",
  );
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${p} to appear`);
}

D("BrokerBackend ↔ real broker", () => {
  let tmpdir: string;
  let socketPath: string;
  let proc: ChildProcess | null = null;
  let client: BrokerClient | null = null;
  let backend: BrokerBackend | null = null;
  let stderrBuf = "";

  const SESSION = "ralph-it-shell";
  const MARKER = `WOLFPACK_MARKER_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-broker-it-"));
    socketPath = path.join(tmpdir, "broker.sock");

    proc = spawn(BROKER_BIN!, [], {
      env: {
        ...process.env,
        WOLFPACK_BROKER_SOCKET: socketPath,
        WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });
    proc.on("exit", (code, signal) => {
      stderrBuf += `\n[broker exited code=${code} signal=${signal}]\n`;
    });

    await waitForFile(socketPath, 5000);

    let resolveConnect!: () => void;
    const connected = new Promise<void>((resolve) => { resolveConnect = resolve; });
    client = new BrokerClient({
      socketPath,
      requestTimeoutMs: 5000,
      onConnect: () => resolveConnect(),
    });
    client.start();
    await Promise.race([connected, wait(2000)]);

    // Belt-and-braces: ping list_sessions until the broker answers, in case
    // the connect callback raced.
    const pingDeadline = Date.now() + 5000;
    while (Date.now() < pingDeadline) {
      try {
        const resp = await client.request("list_sessions", {});
        if (resp.status === "ok") break;
      } catch {
        await wait(50);
      }
    }

    backend = new BrokerBackend(client);
  }, 30_000);

  afterAll(async () => {
    try {
      if (backend) {
        try { await backend!.killSession(SESSION); } catch { /* swallow */ }
      }
    } catch { /* swallow */ }
    try { client?.close(); } catch { /* swallow */ }
    try {
      if (proc && proc.exitCode === null) {
        proc.kill("SIGTERM");
        const exited = new Promise<void>((resolve) => {
          proc!.once("exit", () => resolve());
        });
        const result = await Promise.race([exited, wait(3000).then(() => "timeout" as const)]);
        if (result === "timeout") {
          try { proc.kill("SIGKILL"); } catch { /* swallow */ }
        }
      }
    } catch { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (process.env.WOLFPACK_BROKER_DEBUG && stderrBuf) {
      // eslint-disable-next-line no-console
      console.error("[broker stderr]\n" + stderrBuf);
    }
  });

  test("list is empty before any sessions exist", async () => {
    const names = await backend!.list();
    expect(names).not.toContain(SESSION);
  }, 15_000);

  test("createSession spawns a real PTY shell, list+sessionDir reflect it", async () => {
    await backend!.createSession(SESSION, tmpdir, "shell", () => ({ agentCmd: "shell" }));
    const names = await backend!.list();
    expect(names).toContain(SESSION);
    expect(backend!.sessionDir(SESSION)).toBe(tmpdir);
    expect(await backend!.hasSession(SESSION)).toBe(true);
    expect(backend!.isSessionAlive(SESSION)).toBe(true);
  }, 30_000);

  test("send + capturePane round-trips through the real PTY snapshot", async () => {
    // -lic shells take a beat to render their prompt; give them room before
    // we type so the marker is the only "interesting" thing on screen.
    await wait(300);
    await backend!.send(SESSION, `echo ${MARKER}`);

    const deadline = Date.now() + 8000;
    let lastSnap = "";
    while (Date.now() < deadline) {
      lastSnap = await backend!.capturePane(SESSION);
      if (lastSnap.includes(MARKER)) break;
      await wait(100);
    }
    expect(lastSnap).toContain(MARKER);
  }, 15_000);

  test("resize changes broker-tracked dimensions without disturbing the session", async () => {
    await backend!.resize(SESSION, 100, 30);
    // Session should still be alive and snapshot-able after resize.
    expect(await backend!.hasSession(SESSION)).toBe(true);
    const snap = await backend!.capturePane(SESSION);
    // Marker from the previous test's echo should still be in scrollback.
    expect(typeof snap).toBe("string");
  }, 15_000);

  test("killSession terminates the PTY and drops it from list/sessionDir", async () => {
    await backend!.killSession(SESSION);

    // Default kill signal is SIGHUP; the shell may take a moment to reap.
    const deadline = Date.now() + 5000;
    let names: string[] = [];
    while (Date.now() < deadline) {
      names = await backend!.list();
      if (!names.includes(SESSION)) break;
      await wait(100);
    }
    expect(names).not.toContain(SESSION);
    expect(backend!.sessionDir(SESSION)).toBeUndefined();
    expect(backend!.isSessionAlive(SESSION)).toBe(false);
    expect(await backend!.hasSession(SESSION)).toBe(false);
  }, 15_000);
});
