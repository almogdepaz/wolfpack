import { resolve } from "node:path";
import { BrokerClient, defaultBrokerSocketPath } from "../broker/client.js";
import { SERVER_LISTENING } from "../server-startup-contract.js";
import { brokerProgramPath, validateExecutableCandidate } from "./service.js";
import type { Config } from "./config.js";
import { APPLICATION_READY_TIMEOUT_MS, applicationReady } from "./readiness.js";

const BROKER_START_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;

async function brokerReady(timeoutMs: number): Promise<boolean> {
  const client = new BrokerClient({ socketPath: defaultBrokerSocketPath() });
  client.start();
  try {
    const deadline = Date.now() + timeoutMs;
    while (!client.isConnected() && Date.now() < deadline) await Bun.sleep(25);
    if (!client.isConnected()) return false;
    // A connected but unhealthy independent broker is not ours to replace.
    const response = await client.request("list_sessions", {}, { timeoutMs: 1000 });
    if (response.status !== "ok") throw new Error("broker rejected readiness handshake");
    return true;
  } finally { client.close(); }
}

async function stopOwnedChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

/** Supervise only invocation-owned children; never stop an independent broker. */
export async function startForeground(config: Config, onReady: () => void, packageBroker?: string): Promise<void> {
  if (packageBroker !== undefined) validateExecutableCandidate(packageBroker, "wolfpack-broker");
  let broker: Bun.Subprocess | undefined;
  let server: Bun.Subprocess | undefined;
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping = true;
    shutdown ??= (async () => {
      if (server) await stopOwnedChild(server);
      if (broker) await stopOwnedChild(broker);
    })();
    return shutdown;
  };
  const onSignal = (): void => { void stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    if (!await brokerReady(300)) {
      const binary = packageBroker ?? brokerProgramPath();
      if (!binary) throw new Error("Could not locate wolfpack-broker. Reinstall the matching binary pair.");
      if (stopping) return;
      broker = Bun.spawn([binary], {
        env: { ...process.env, WOLFPACK_BROKER_SOCKET: defaultBrokerSocketPath() },
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      if (!await brokerReady(BROKER_START_TIMEOUT_MS)) throw new Error("Foreground broker did not become ready.");
      if (broker.exitCode !== null) throw new Error(`Foreground broker exited (${broker.exitCode}).`);
    }
    if (stopping) return;
    const executable = process.execPath;
    const isBun = executable.endsWith("/bun") || executable.endsWith("/bun.exe");
    const entry = process.argv[1];
    if (isBun && !entry) throw new Error("Missing foreground server entrypoint.");
    const args = isBun ? [executable, resolve(entry!)] : [executable];
    let listening = false;
    server = Bun.spawn(args, {
      ipc(message: unknown): void {
        if (typeof message === "object" && message !== null
          && "type" in message && message.type === SERVER_LISTENING
          && "port" in message && message.port === config.port) listening = true;
      },
      env: { ...process.env, WOLFPACK_SERVICE: "1", WOLFPACK_DEV_DIR: config.devDir, WOLFPACK_PORT: String(config.port) },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const deadline = Date.now() + APPLICATION_READY_TIMEOUT_MS;
    let ready = false;
    while (!stopping && Date.now() < deadline && server.exitCode === null && (!broker || broker.exitCode === null)) {
      ready = listening && await applicationReady(config.port, Math.min(500, deadline - Date.now()));
      if (ready) break;
      await Bun.sleep(100);
    }
    if (stopping) return;
    if (!ready || server.exitCode !== null || (broker && broker.exitCode !== null)) {
      throw new Error(`Foreground startup failed; application not ready at localhost:${config.port}.`);
    }
    onReady();
    const exitCode = await Promise.race([server.exited, ...(broker ? [broker.exited] : [])]);
    if (!stopping) throw new Error(`Foreground process exited unexpectedly (${exitCode}).`);
  } finally {
    // Retain handlers during idempotent cleanup so group Ctrl-C cannot interrupt it.
    await stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
