export interface TailscaleCommandRunner {
  readonly run: (file: string, args: readonly string[]) => string;
}

export type TailscaleRemoteAccessResult =
  | { readonly status: "verified"; readonly hostname: string }
  | { readonly status: "unverified" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseTailscaleHostname(statusJson: string): string | undefined {
  try {
    const status = asRecord(JSON.parse(statusJson));
    const self = asRecord(status?.Self);
    const value = self?.DNSName;
    if (typeof value !== "string") return undefined;
    const hostname = value.replace(/\.$/, "").toLowerCase();
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
}

export function verifiesTailscaleServe(statusJson: string, hostname: string, port: number): boolean {
  try {
    const status = asRecord(JSON.parse(statusJson));
    const web = asRecord(status?.Web);
    const entry = asRecord(web?.[`${hostname}:443`]);
    const handlers = asRecord(entry?.Handlers);
    const rootHandler = asRecord(handlers?.["/"]);
    const proxy = rootHandler?.Proxy;
    if (typeof proxy !== "string") return false;
    const target = new URL(proxy);
    return (target.hostname === "127.0.0.1" || target.hostname === "localhost")
      && target.port === String(port);
  } catch {
    return false;
  }
}

export function configureTailscaleRemoteAccess(options: {
  readonly binary: string;
  readonly port: number;
  readonly run: TailscaleCommandRunner["run"];
}): TailscaleRemoteAccessResult {
  try {
    const hostname = parseTailscaleHostname(options.run(options.binary, ["status", "--self", "--json"]));
    if (!hostname) return { status: "unverified" };
    options.run(options.binary, ["serve", "--bg", String(options.port)]);
    const serveStatus = options.run(options.binary, ["serve", "status", "--json"]);
    return verifiesTailscaleServe(serveStatus, hostname, options.port)
      ? { status: "verified", hostname }
      : { status: "unverified" };
  } catch {
    return { status: "unverified" };
  }
}
