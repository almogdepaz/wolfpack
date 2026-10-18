import { execFileSync } from "node:child_process";
import { exec, type ExecFn } from "./shell.js";

const TAILSCALE_MAX_BUFFER = 10 * 1024 * 1024;
export const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;
export const TAILSCALE_STATUS_CACHE_TTL_MS = 1_000;

// Must invoke via login shell: the macOS App Store Tailscale CLI
// (/Applications/Tailscale.app/Contents/MacOS/Tailscale) relies on the user's
// session env to reach the GUI-hosted daemon. Under launchd's stripped env a
// direct execFile prints "The Tailscale GUI failed to start..." to stdout
// (exit 0), which then fails JSON.parse. `/bin/sh -l -c` sources the user's
// login profile so the bridge resolves. Revert warning: do NOT "simplify" to
// a direct execFile — that silently breaks discovery on App Store installs.
function buildTailscaleStatusCommandArgv(tsBin: string, selfOnly: boolean): { cmd: string; args: string[] } {
  // --self only controls whether the local machine is displayed and defaults
  // to true; --peers=false is what prevents the full peer map from loading.
  const peersFlag = selfOnly ? " --peers=false" : "";
  return { cmd: "/bin/sh", args: ["-l", "-c", `"${tsBin}" status${peersFlag} --json`] };
}

export function buildTailscaleStatusArgv(tsBin: string): { cmd: string; args: string[] } {
  return buildTailscaleStatusCommandArgv(tsBin, false);
}

export function buildTailscaleSelfStatusArgv(tsBin: string): { cmd: string; args: string[] } {
  return buildTailscaleStatusCommandArgv(tsBin, true);
}

function findTailscaleBinary(): string | undefined {
  return [
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((path) => {
    try {
      execFileSync("test", ["-x", path]);
      return true;
    } catch {
      return false;
    }
  });
}

export function createTailscaleStatusCache(
  readStatus: () => Promise<unknown>,
  now: () => number = Date.now,
): { readonly read: () => Promise<unknown> } {
  let cached: { readonly status: unknown; readonly expiresAt: number } | undefined;
  let inFlight: Promise<unknown> | undefined;

  return {
    read(): Promise<unknown> {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.status);
      if (inFlight) return inFlight;
      try {
        inFlight = readStatus()
          .then((status) => {
            cached = { status, expiresAt: now() + TAILSCALE_STATUS_CACHE_TTL_MS };
            return status;
          })
          .finally(() => {
            inFlight = undefined;
          });
        return inFlight;
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
  };
}

export async function executeTailscaleStatus(
  binary: string,
  run: ExecFn = exec,
  selfOnly = false,
): Promise<unknown> {
  const { cmd, args } = selfOnly
    ? buildTailscaleSelfStatusArgv(binary)
    : buildTailscaleStatusArgv(binary);
  const { stdout } = await run(cmd, args, {
    maxBuffer: TAILSCALE_MAX_BUFFER,
    timeout: TAILSCALE_STATUS_TIMEOUT_MS,
  });
  return JSON.parse(stdout) as unknown;
}

async function readLocalTailscaleStatusUncached(selfOnly = false): Promise<unknown> {
  const binary = findTailscaleBinary();
  if (!binary) throw new Error("tailscale not found");
  return executeTailscaleStatus(binary, exec, selfOnly);
}

const localTailscaleStatusCache = createTailscaleStatusCache(() => readLocalTailscaleStatusUncached());
const localTailscaleSelfStatusCache = createTailscaleStatusCache(() => readLocalTailscaleStatusUncached(true));

export async function readRelayPeerTopology(configuredOrigin: string | undefined): Promise<import("../task-relay/peer-topology.ts").RelayPeerTopology> {
  if (!configuredOrigin) throw new Error("relay peer policy unavailable");
  const { relayPeerTopology } = await import("../task-relay/peer-topology.ts");
  return relayPeerTopology(await readLocalTailscaleStatus(), configuredOrigin);
}

export async function readLocalTailscaleStatus(selfOnly = false): Promise<unknown> {
  const testStatus = process.env.WOLFPACK_TEST ? process.env.WOLFPACK_TAILSCALE_STATUS_JSON : undefined;
  if (testStatus !== undefined) return JSON.parse(testStatus) as unknown;
  return selfOnly ? localTailscaleSelfStatusCache.read() : localTailscaleStatusCache.read();
}
