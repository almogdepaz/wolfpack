import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { hostname, platform } from "node:os";
import { loadConfig } from "./config.js";
import { isMachineDisplayName } from "./tailnet-machine-contract.js";

/** Display metadata only. configuredName is the host config `displayName` override. */
export function resolveMachineDisplayName(input: {
  readonly configuredName?: unknown;
  readonly computerName?: unknown;
  readonly hostName: string;
}): string {
  const hostName = input.hostName.replace(/\.local$/, "").replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
  for (const value of [input.configuredName, input.computerName, hostName]) {
    const name = typeof value === "string" ? value.trim() : undefined;
    if (isMachineDisplayName(name)) return name;
  }
  return "this machine";
}

type ComputerNameRunner = (file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

/** Fixed, read-only OS commands; never a shell or a Tailnet query. */
export function readComputerName(system: NodeJS.Platform = platform(), run: ComputerNameRunner = execFileSync): string | undefined {
  const command = system === "darwin" ? ["/usr/sbin/scutil", "--get", "ComputerName"]
    : system === "linux" ? ["/usr/bin/hostnamectl", "--pretty"] : undefined;
  if (!command) return undefined;
  try {
    return run(command[0]!, command.slice(1), { encoding: "utf8", timeout: 500, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return undefined; }
}

// Capture the name once at process startup; changing the configured name takes
// a server restart. No request-time probe, cache timers, separate name file, or
// dependency on Tailscale availability.
const startupDisplayName = resolveMachineDisplayName({
  configuredName: loadConfig()?.displayName,
  computerName: readComputerName(),
  hostName: hostname(),
});

export function getMachineDisplayName(): string {
  return startupDisplayName;
}
