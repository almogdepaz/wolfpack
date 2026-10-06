import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { hostname, platform } from "node:os";
import { isMachineDisplayName } from "./tailnet-machine-contract.js";

/** Display metadata only. A future host setting can supply configuredName here. */
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

// Capture the automatic default once at process startup. No request-time probe,
// cache timers, persistent name file, or dependency on Tailscale availability.
const defaultDisplayName = resolveMachineDisplayName({ computerName: readComputerName(), hostName: hostname() });

export function getMachineDisplayName(): string {
  return defaultDisplayName;
}
