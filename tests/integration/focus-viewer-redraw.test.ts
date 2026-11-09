process.env.WOLFPACK_TEST = "1";

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { BrokerClient } from "../../src/broker/client";
import { BrokerBackend } from "../../src/server/broker-backend";
import { BrokerSupervisor } from "../../src/server/broker-supervisor";
import type { SessionBackend } from "../../src/server/backend-contract";
import { createServerContext } from "../../src/server/context";
import { handlePtyWs, teardownPty } from "../../src/server/websocket";
import { observeDashboardSessions, __resetSessionObservationForTests } from "../../src/server/session-observation";
import { getAgentRuntimeStateStore } from "../../src/server/agent-status";
import { stoppedUnseen } from "../../src/focus-ranking";

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 7000, timeoutMessage = "condition timed out") {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(timeoutMessage); await wait(60); }
}
class Viewer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  send(data: string | Buffer) { if (typeof data === "string") this.frames.push(data); }
  close() { this.readyState = 3; this.emit("close"); }
  ping() {}
  terminate() { this.close(); }
  control(data: object) { this.emit("message", Buffer.from(JSON.stringify(data)), false); }
}

const binary = process.env.WOLFPACK_BROKER_BIN;
test.skipIf(!binary || !existsSync(binary))("production proxy shares PTY redraw attribution, input cancellation and ended-session pruning", async () => {
  const root = mkdtempSync("/tmp/focus-redraw-");
  const socketPath = join(root, "b.sock");
  const proc = spawn(binary!, [], { env: { ...process.env, WOLFPACK_BROKER_SOCKET: socketPath }, stdio: "ignore" });
  let backend: BrokerBackend | undefined;
  const client = new BrokerClient({ socketPath, requestTimeoutMs: 3000, onEvent: event => backend?.ingestEvent(event) });
  const session = "focus-redraw-it";
  const viewer = new Viewer();
  try {
    await until(() => existsSync(socketPath));
    client.start();
    await until(async () => { try { return (await client.request("list_sessions", {})).status === "ok"; } catch { return false; } });
    backend = new BrokerBackend(client);
    // SIGWINCH produces an unmistakably changed screen, not just unchanged raw bytes.
    writeFileSync(join(root, "work.sh"), "#!/bin/bash\ntrap 'printf \"viewer redraw %s\\n\" \"$((++n))\"' WINCH\nprintf 'ready\\n'\nwhile true; do if [ -f work ]; then rm work; printf 'real later work\\n'; fi; sleep .05; done\n", { mode: 0o700 });
    const identity = await backend.createSession(session, root, "./work.sh", () => ({ agentCmd: "shell" }), { agentKind: "custom" });
    // Production observation/CLI retain the proxy; websocket pins the raw backend.
    const supervisor = new BrokerSupervisor({ start: false });
    const injected: SessionBackend = backend;
    supervisor.__setBrokerForTest(injected);
    const ctx = createServerContext({ supervisor, config: null, taskRelayRoot: join(root, "relay") });
    expect(ctx.backend).not.toBe(backend);
    const observe = async () => (await observeDashboardSessions(ctx)).find(s => s.name === session)!.runtimeState;
    await until(async () => (await backend!.capturePane(session)).includes("ready"));
    await observe(); // Baseline.
    writeFileSync(join(root, "work"), "");
    await until(async () => (await observe()).state === "output");
    await until(async () => stoppedUnseen(await observe()));
    const first = await observe();
    getAgentRuntimeStateStore().acknowledge(identity.wolfpackSessionId, first.transitionSequence);
    handlePtyWs(viewer as unknown as WebSocket, session, undefined, ctx);
    viewer.control({ type: "attach", cols: 71, rows: 21, prefillMode: "full" });
    await until(() => viewer.frames.some(f => JSON.parse(f).type === "pty_ready"));
    await until(async () => (await backend!.capturePane(session)).includes("viewer redraw"));
    // Observe the changed redraw, then its following idle, after the attribution window.
    await observe();
    await wait(1600);
    const reviewed = await observe();
    expect(stoppedUnseen(reviewed)).toBe(false);
    expect(reviewed.stoppedAt).toBe(first.stoppedAt);
    viewer.control({ type: "resize", cols: 83, rows: 25, resizeId: 1 });
    await until(() => viewer.frames.some(f => JSON.parse(f).type === "resize_ack"));
    await wait(1600);
    await observe();
    await wait(1100);
    expect(stoppedUnseen(await observe())).toBe(false);
    writeFileSync(join(root, "work"), "");
    await until(async () => (await observe()).state === "output");
    await until(async () => stoppedUnseen(await observe()));
    expect((await observe()).stoppedAt).not.toBe(first.stoppedAt);
    const fact = (await ctx.backend.listSessionFacts()).find(f => f.name === session)!;
    await ctx.viewerRedraw.begin(session);
    expect(ctx.viewerRedraw.includes(fact)).toBe(true);
    viewer.emit("message", Buffer.from("x"), true);
    expect(ctx.viewerRedraw.includes(fact)).toBe(false); // Pinned websocket input cancels the observer's owner.
    await wait(1100);
    await ctx.viewerRedraw.begin(session);
    expect(ctx.viewerRedraw.includes(fact)).toBe(true);
    await backend.killSession(session);
    // Kill acknowledgement precedes the broker's asynchronous exit observation.
    await until(async () => !(await ctx.backend.listSessionFacts()).some(f => f.alive && f.identity?.wolfpackSessionId === identity.wolfpackSessionId),
      7000, "killed session remained alive in broker facts before pruning");
    await observeDashboardSessions(ctx);
    expect(ctx.viewerRedraw.includes(fact)).toBe(false); // Production observation prunes that same owner.
  } finally {
    teardownPty(session);
    if (backend) await backend.killSession(session);
    client.close();
    const exit = new Promise<void>(resolve => proc.once("exit", () => resolve()));
    proc.kill("SIGTERM");
    await exit;
    __resetSessionObservationForTests();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
