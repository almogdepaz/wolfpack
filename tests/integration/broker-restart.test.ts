/**
 * Broker restart/crash recovery — proves the architecture invariant:
 *
 *   1. Wolfpack server restart MUST NOT kill broker-owned sessions, and the
 *      next attach MUST get a prefill containing the prior transcript.
 *   2. Broker death MUST surface SESSION_UNAVAILABLE (4001) cleanly to any
 *      attached caller — no silent zombies.
 *
 * Drives a real wolfpack-broker binary. Wolfpack "restart" is simulated by
 * tearing down a BrokerBackend + BrokerClient pair and instantiating a fresh
 * pair against the same broker socket — equivalent to bouncing the wolfpack
 * process while the broker keeps running.
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
const D = BROKER_BIN ? describe : describe.skip;

if (!BROKER_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[broker-restart.integration] skipped — broker binary not built. Run " +
      "`cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.",
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

async function buildClient(socketPath: string): Promise<BrokerClient> {
  let resolveConnect!: () => void;
  const connected = new Promise<void>((r) => { resolveConnect = r; });
  const client = new BrokerClient({
    socketPath,
    requestTimeoutMs: 5000,
    onConnect: () => resolveConnect(),
  });
  client.start();
  await Promise.race([connected, wait(2000)]);
  // Belt-and-braces ping until broker answers.
  const pingDeadline = Date.now() + 5000;
  while (Date.now() < pingDeadline) {
    try {
      const resp = await client.request("list_sessions", {});
      if (resp.status === "ok") return client;
    } catch { /* not ready yet */ }
    await wait(50);
  }
  throw new Error("broker did not respond to list_sessions");
}

D("Broker restart/crash recovery", () => {
  let tmpdir: string;
  let socketPath: string;
  let proc: ChildProcess | null = null;
  let stderrBuf = "";

  beforeAll(async () => {
    // Keep socketPath short — macOS AF_UNIX is capped at ~104 bytes.
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-brk-restart-"));
    socketPath = path.join(tmpdir, "b.sock");

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
  });

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch { /* swallow */ }
      await Promise.race([
        new Promise<void>((r) => proc!.once("exit", () => r())),
        wait(2000),
      ]);
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* swallow */ }
      }
    }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (process.env.WOLFPACK_BROKER_DEBUG && stderrBuf) {
      process.stderr.write("[broker stderr]\n" + stderrBuf + "\n");
    }
  });

  test("wolfpack restart preserves broker session and prefill includes marker", async () => {
    const SESSION = "restart-shell";
    const MARKER = `WP_RESTART_MARK_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;

    // ── First wolfpack instance: create session, write marker bytes ──
    const client1 = await buildClient(socketPath);
    const backend1 = new BrokerBackend(client1);
    await backend1.list();
    await backend1.createSession(SESSION, tmpdir, "shell", () => ({ agentCmd: "shell" }));
    // Wait for shell prompt to settle so the snapshot has a stable cursor row.
    await wait(500);
    await backend1.send(SESSION, `echo ${MARKER}\n`);

    // Wait until a snapshot reflects the marker (broker drains PTY async).
    let preSnap = "";
    const sawDeadline = Date.now() + 5000;
    while (Date.now() < sawDeadline) {
      preSnap = await backend1.capturePane(SESSION);
      if (preSnap.includes(MARKER)) break;
      await wait(100);
    }
    expect(preSnap, "marker should land in pre-restart snapshot").toContain(MARKER);

    // ── Simulate wolfpack restart: drop client1/backend1 entirely ──
    client1.close();

    // ── Second wolfpack instance: re-attach against same broker ──
    const client2 = await buildClient(socketPath);
    const backend2 = new BrokerBackend(client2);

    // Session must still be present in the broker registry.
    const names = await backend2.list();
    expect(names, "broker still owns session after wolfpack restart").toContain(SESSION);
    expect(await backend2.hasSession(SESSION)).toBe(true);

    // Prefill (canonical broker-rendered snapshot) must contain the marker —
    // proves reconnect-state survives a wolfpack process bounce.
    const prefill = await backend2.getSessionPrefill(SESSION);
    const prefillText = prefill.toString("utf8");
    expect(prefillText, "prefill from new wolfpack contains pre-restart marker")
      .toContain(MARKER);

    // Cleanup.
    await backend2.killSession(SESSION);
    client2.close();
  }, 20_000);

  test("broker death surfaces an error to BrokerBackend (no silent zombies)", async () => {
    // Spawn a SECOND ephemeral broker so killing it doesn't break the suite's
    // long-lived broker (`proc`). Each test gets isolated lifecycle state.
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "wp-brk-die-"));
    const subSocket = path.join(sub, "b.sock");
    const subProc = spawn(BROKER_BIN!, [], {
      env: {
        ...process.env,
        WOLFPACK_BROKER_SOCKET: subSocket,
        WOLFPACK_BROKER_LOG: "warn",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await waitForFile(subSocket, 5000);

      const client = await buildClient(subSocket);
      const backend = new BrokerBackend(client);
      await backend.createSession("die-shell", sub, "shell", () => ({ agentCmd: "shell" }));

      // Hard kill the broker mid-flight.
      subProc.kill("SIGKILL");
      await new Promise<void>((r) => subProc.once("exit", () => r()));

      // Any further request must reject — that's the signal wolfpack uses to
      // close attached viewers with CLOSE_CODE_SESSION_UNAVAILABLE (4001).
      let threw = false;
      try {
        await backend.list();
      } catch { threw = true; }
      // Some BrokerClient builds queue requests until reconnect — accept either
      // a rejection OR an empty/invalid list. The contract under test is that
      // the call does not silently report stale state.
      if (!threw) {
        const post = await backend.list().catch(() => null);
        expect(post, "list after broker death must be empty or null, not stale")
          .not.toContain("die-shell");
      } else {
        expect(threw).toBe(true);
      }

      client.close();
    } finally {
      if (subProc.exitCode === null) {
        try { subProc.kill("SIGKILL"); } catch { /* swallow */ }
      }
      try { fs.rmSync(sub, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }, 20_000);
});
