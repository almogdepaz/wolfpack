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

import {
  server,
  __setTmuxList,
  __setTmuxListWithActivity,
  __setTmuxSend,
  __setTmuxSendKey,
} from "../../serve.ts";

// ── Mock tmux ──

const fakeSessions = [
  { name: "test-project", activity: Math.floor(Date.now() / 1000) },
  { name: "another-project", activity: Math.floor(Date.now() / 1000) - 30 },
];

__setTmuxList(async () => fakeSessions.map((s) => s.name));
__setTmuxListWithActivity(async () => [...fakeSessions]);
__setTmuxSend(async () => {});
__setTmuxSendKey(async () => {});

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
