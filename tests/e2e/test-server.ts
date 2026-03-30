#!/usr/bin/env bun
/**
 * Test server harness — run with `bun tests/e2e/test-server.ts`.
 *
 * Starts the real wolfpack server with mock tmux stubs on a random port.
 * Prints `READY:<port>` to stdout when listening.
 * Exits on SIGTERM or when stdin closes (parent process dies).
 */
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

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

// Exit when parent disconnects
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
