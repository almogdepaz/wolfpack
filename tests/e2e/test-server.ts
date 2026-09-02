#!/usr/bin/env bun
/**
 * Test server harness — run with `bun tests/e2e/test-server.ts`.
 *
 * Starts the real wolfpack server with mock tmux stubs on a random port.
 * Prints `READY:<port>` to stdout when listening.
 * Exits on SIGTERM or when stdin closes (parent process dies).
 */
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  assertOwnedTestServerHome,
  createOwnedTestServerHome,
  removeOwnedTestServerHome,
  type OwnedTestServerHome,
} from "./test-server-home";

const ISOLATED_HOME_ARG = "--isolated-e2e-home";
const BOOTSTRAP_OWNED_ISOLATED_HOME_ARG = "--bootstrap-owned-isolated-e2e-home";
const isolatedHomeArg = process.argv[2];
const bootstrapOwnedHome: OwnedTestServerHome | undefined = isolatedHomeArg === BOOTSTRAP_OWNED_ISOLATED_HOME_ARG
  ? { path: process.argv[3] ?? "", token: process.argv[4] ?? "" }
  : undefined;
const isolatedHome = isolatedHomeArg === ISOLATED_HOME_ARG ? process.argv[3] : undefined;

async function runOwnedBootstrap(home: OwnedTestServerHome): Promise<never> {
  assertOwnedTestServerHome(home);
  const child = spawn(process.execPath, [import.meta.path, ISOLATED_HOME_ARG, home.path], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home.path },
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
    removeOwnedTestServerHome(home);
  }
  process.exit(exitCode);
}

// Bun resolves os.homedir() when it starts, before this script can change HOME.
// Re-exec so every production module sees the fresh test home from process start.
if (bootstrapOwnedHome) await runOwnedBootstrap(bootstrapOwnedHome);

if (!isolatedHome) {
  const ownedHome = createOwnedTestServerHome();
  await runOwnedBootstrap(ownedHome);
}

process.env.HOME = isolatedHome;
process.env.WOLFPACK_TEST = "1";
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exit(0);
};
process.stdin.resume();
process.stdin.once("end", shutdown);
if (process.env.WOLFPACK_E2E_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
} else {
  process.once("SIGTERM", shutdown);
}
process.env.WOLFPACK_MACHINE_ID_PATH = join(import.meta.dirname, "fixtures", "test-server-installation-id");
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: {
    ID: "n-e2e-test-server",
    HostName: "e2e-test-server",
    DNSName: "e2e-test-server.example.ts.net.",
  },
  Peer: {},
});

// Keep the default fixture hermetic: peer-specific specs intercept this endpoint
// in the browser, while ordinary specs must never probe the developer's Tailnet.
const { mock: bunMock } = await import("bun:test");
const realHttp = await import("../../src/server/http.ts");
await bunMock.module("../../src/server/http.js", () => ({
  ...realHttp,
  enumerateLocalTailnetCandidates: async () => ({ candidates: [] }),
}));

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
