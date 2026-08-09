#!/usr/bin/env bun
/**
 * Test server harness — run with `bun tests/e2e/test-server.ts`.
 *
 * Starts the real wolfpack server with mock tmux stubs on a random port.
 * Prints `READY:<port>` to stdout when listening.
 * Exits on SIGTERM or when stdin closes (parent process dies).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED_HOME_ARG = "--isolated-e2e-home";
const isolatedHome = process.argv[2] === ISOLATED_HOME_ARG ? process.argv[3] : undefined;

// Bun resolves os.homedir() when it starts, before this script can change HOME.
// Re-exec so every production module sees the fresh test home from process start.
if (!isolatedHome) {
  const freshHome = mkdtempSync(join(tmpdir(), "wolfpack-e2e-server-"));
  const child = spawn(process.execPath, [import.meta.path, ISOLATED_HOME_ARG, freshHome], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: freshHome },
    stdio: "inherit",
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    rmSync(freshHome, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

process.env.HOME = isolatedHome;
process.env.WOLFPACK_TEST = "1";
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
process.env.WOLFPACK_MACHINE_ID_PATH = join(import.meta.dirname, "fixtures", "test-server-installation-id");
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: {
    ID: "n-e2e-test-server",
    HostName: "e2e-test-server",
    DNSName: "e2e-test-server.example.ts.net.",
  },
  Peer: {},
});

const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");

// ── Mock backend ──

const fakeSessions = [
  "test-project",
  "another-project",
  "prompt-project",
  "error-project",
];

const paneContent: Record<string, string> = {
  "test-project": "$ mock-terminal-ready\n",
  "another-project": "$ idle\n",
  "prompt-project": "Building project...\nDo you want to continue? (y/n)\n",
  "error-project": "$ bun test\nError: 3 tests failed\n",
};

const mock = new MockBackend({
  sessions: fakeSessions,
  capturePane: async (session) => paneContent[session] || "",
});
__setTestBackend(mock);

const { server } = await import("../../src/server/index.ts");

// Suppress expected tmux noise
const origError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("tmux") || msg.includes("WS error") || msg.includes("spawn")) return;
  origError(...args);
};

// ── Listen ──

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  // Signal to parent that we're ready
  console.log(`READY:${port}`);
});
