import { isIP, isIPv4, isIPv6 } from "node:net";

export interface HostPolicyOptions {
  /** Canonical FQDN from config tailscaleHostname (no scheme), or undefined. */
  readonly configuredHostname: string | undefined;
  /** Extra hosts normalized by parseConfig. */
  readonly extraHosts: readonly string[];
  /** Returns the parsed Tailscale self status, or throws. */
  readonly readSelfStatus: () => Promise<unknown>;
}

export interface HostPolicy {
  isAllowed(hostHeader: string | undefined): Promise<boolean>;
}

/** Parse an HTTP Host authority without accepting URL paths, credentials or IPv6 zone IDs. */
export function parseHostHeader(value: string): string | null {
  if (/[\s\x00-\x1f\x7f]/.test(value)) return null;
  let host: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([0-9a-fA-F:.]+)\](?::([0-9]{1,5}))?$/.exec(value);
    if (!match || !isIPv6(match[1])) return null;
    host = new URL(`http://[${match[1]}]`).hostname.slice(1, -1).toLowerCase();
    port = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(value);
    if (!match) return null;
    host = match[1].toLowerCase().replace(/\.$/, "");
    port = match[2];
    if (host.length > 253 || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  }
  if (port !== undefined && Number(port) > 65535) return null;
  return host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addHostname(hosts: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const host = parseHostHeader(value);
  if (!host) return;
  hosts.add(host);
  if (!isIP(host)) hosts.add(host.split(".")[0]);
}

function selfHosts(status: unknown): Set<string> {
  const hosts = new Set<string>();
  if (!isRecord(status) || !isRecord(status.Self)) return hosts;
  addHostname(hosts, status.Self.DNSName);
  if (Array.isArray(status.Self.TailscaleIPs)) {
    for (const ip of status.Self.TailscaleIPs) {
      if (typeof ip !== "string" || !isIP(ip)) continue;
      const host = parseHostHeader(isIPv6(ip) ? `[${ip}]` : ip);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

function canRefreshSelf(host: string): boolean {
  if (isIPv4(host)) {
    const [first, second] = host.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  if (isIPv6(host)) return host.startsWith("fd7a:115c:a1e0:");
  // A renamed MagicDNS name can be a short name or a .ts.net FQDN, but
  // arbitrary foreign DNS names must not trigger a Tailscale subprocess.
  return !host.includes(".") || host.endsWith(".ts.net");
}

export function createHostPolicy(options: HostPolicyOptions): HostPolicy {
  const fixedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  addHostname(fixedHosts, options.configuredHostname);
  for (const extra of options.extraHosts) {
    const host = parseHostHeader(isIPv6(extra) ? `[${extra}]` : extra);
    if (host) fixedHosts.add(host);
  }
  let discoveredHosts = new Set<string>();
  async function refresh(): Promise<void> {
    try {
      discoveredHosts = selfHosts(await options.readSelfStatus());
    } catch {
      // Discovery is optional: retain the last self identity on read failure.
      // Configured names and loopback remain usable even without Tailscale.
    }
  }
  const initialRead = refresh();
  return {
    async isAllowed(hostHeader) {
      const host = hostHeader === undefined ? null : parseHostHeader(hostHeader);
      if (!host) return false;
      if (fixedHosts.has(host)) return true;
      await initialRead;
      if (discoveredHosts.has(host)) return true;
      if (!canRefreshSelf(host)) return false;
      await refresh();
      return discoveredHosts.has(host);
    },
  };
}
