import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isValidPort } from "../../src/validation.ts";

export const TAILNET_ORIGIN_IPC_MESSAGE_TYPE = {
  DISPATCH_STATE: "dispatch-state",
  READY: "ready",
} as const;

export interface TailnetOriginReadyMessage {
  readonly type: typeof TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY;
  readonly port: number;
}

export function getTailnetReadyPort(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const readyMessage = message as { readonly type: unknown; readonly port: unknown };
  if (readyMessage.type !== TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY || typeof readyMessage.port !== "number") return undefined;
  return isValidPort(readyMessage.port) ? readyMessage.port : undefined;
}

export const TAILNET_CONFIGURED_HOSTNAME = "workstation.tailnet.ts.net";
const TAILNET_CONFIG_PORT = 18790;
export const TAILNET_SIBLING_ORIGIN = "https://phone.tailnet.ts.net";
export const TAILNET_REJECTED_ORIGINS = [
  "https://evil.example",
  "https://phone.tailnet.ts.net.evil.example",
] as const;

export interface TailnetOriginServerFixture {
  readonly base: string;
  readonly wasDispatched: (session: string) => Promise<boolean>;
  readonly stop: () => Promise<void>;
}

async function waitForReady(child: ChildProcess, stderr: { value: string }): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`tailnet fixture did not report its bound port: ${stderr.value}`), undefined), 10_000);
    let settled = false;
    const finish = (error: Error | undefined, port: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stderr?.off("data", onStderr);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (port === undefined) reject(new Error("tailnet fixture did not report a port"));
      else resolve(port);
    };
    const onMessage = (message: unknown): void => {
      const port = getTailnetReadyPort(message);
      if (port !== undefined) finish(undefined, port);
    };
    const onStderr = (chunk: Buffer): void => { stderr.value += chunk.toString(); };
    const onError = (error: Error): void => finish(error, undefined);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`tailnet fixture exited before ready (code ${code}, signal ${signal}): ${stderr.value}`), undefined);
    };
    child.stderr?.on("data", onStderr);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function dispatchedInChild(child: ChildProcess, session: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (!child.send) {
      reject(new Error("tailnet fixture IPC is unavailable"));
      return;
    }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => finish(new Error(`tailnet fixture did not report dispatch for ${session}`)), 5_000);
    const finish = (error: Error | undefined, dispatched = false): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(dispatched);
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object") return;
      const response = message as Record<string, unknown>;
      if (response.type === TAILNET_ORIGIN_IPC_MESSAGE_TYPE.DISPATCH_STATE && response.requestId === requestId) {
        finish(undefined, response.dispatched === true);
      }
    };
    child.on("message", onMessage);
    child.send({ type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.DISPATCH_STATE, requestId, session });
  });
}

export async function createTailnetOriginServerFixture(): Promise<TailnetOriginServerFixture> {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-tailnet-origin-"));
  const configDirectory = join(home, ".wolfpack");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
    devDir: join(home, "dev"),
    port: TAILNET_CONFIG_PORT,
    tailscaleHostname: TAILNET_CONFIGURED_HOSTNAME,
  }));

  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "tailnet-origin-server.ts")], {
    cwd: join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      HOME: home,
      WOLFPACK_TEST: "1",
      WOLFPACK_PORT: String(TAILNET_CONFIG_PORT),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const stderr = { value: "" };
  let port: number;
  try {
    port = await waitForReady(child, stderr);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    base: `http://127.0.0.1:${port}`,
    wasDispatched: (session: string): Promise<boolean> => dispatchedInChild(child, session),
    stop: async (): Promise<void> => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
