import { canonicalTailnetOrigin } from "../tailnet-machine-contract.js";

export interface TailscaleCommandRunner {
  readonly run: (file: string, args: readonly string[]) => string;
}

export type TailscaleRemoteAccessResult =
  | { readonly status: "verified"; readonly hostname: string; readonly origin: string }
  | { readonly status: "unavailable" }
  | { readonly status: "logged-out" }
  | { readonly status: "malformed-status" }
  | { readonly status: "serve-unverified" };

export type TailscaleSelfResult =
  | { readonly status: "ready"; readonly hostname: string; readonly origin: string }
  | { readonly status: "unavailable" }
  | { readonly status: "logged-out" }
  | { readonly status: "malformed-status" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function inspectTailscaleSelf(statusJson: string): TailscaleSelfResult {
  try {
    const status = asRecord(JSON.parse(statusJson));
    if (!status) return { status: "malformed-status" };
    if (!Object.hasOwn(status, "Self")) return { status: "logged-out" };
    const self = asRecord(status.Self);
    if (!self || !Object.hasOwn(self, "DNSName")) return { status: "logged-out" };
    const origin = canonicalTailnetOrigin(self.DNSName);
    if (!origin) return { status: "malformed-status" };
    return { status: "ready", hostname: origin.slice("https://".length), origin };
  } catch {
    return { status: "malformed-status" };
  }
}

export function parseTailscaleHostname(statusJson: string): string | undefined {
  const result = inspectTailscaleSelf(statusJson);
  return result.status === "ready" ? result.hostname : undefined;
}

export function verifiesTailscaleServe(statusJson: string, hostname: string, port: number): boolean {
  const origin = canonicalTailnetOrigin(hostname);
  if (!origin || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const status = asRecord(JSON.parse(statusJson));
    const web = asRecord(status?.Web);
    const entry = asRecord(web?.[`${origin.slice("https://".length)}:443`]);
    const handlers = asRecord(entry?.Handlers);
    const rootHandler = asRecord(handlers?.["/"]);
    const proxy = rootHandler?.Proxy;
    if (typeof proxy !== "string") return false;
    const target = new URL(proxy);
    return target.protocol === "http:"
      && (target.hostname === "127.0.0.1" || target.hostname === "localhost")
      && target.port === String(port)
      && target.username === ""
      && target.password === ""
      && target.pathname === "/"
      && target.search === ""
      && target.hash === "";
  } catch {
    return false;
  }
}

/**
 * Configures Tailscale Serve, then proves its exact canonical HTTPS origin
 * reaches this process's loopback listener. A hostname is returned only after
 * that proof; every other state is intentionally non-advertisable.
 */
export function configureTailscaleRemoteAccess(options: {
  readonly binary: string;
  readonly port: number;
  readonly run: TailscaleCommandRunner["run"];
}): TailscaleRemoteAccessResult {
  let selfStatus: string;
  try {
    selfStatus = options.run(options.binary, ["status", "--self", "--json"]);
  } catch {
    return { status: "unavailable" };
  }
  const self = inspectTailscaleSelf(selfStatus);
  if (self.status !== "ready") return self;

  try {
    options.run(options.binary, ["serve", "--bg", String(options.port)]);
    const serveStatus = options.run(options.binary, ["serve", "status", "--json"]);
    return verifiesTailscaleServe(serveStatus, self.hostname, options.port)
      ? { status: "verified", hostname: self.hostname, origin: self.origin }
      : { status: "serve-unverified" };
  } catch {
    return { status: "serve-unverified" };
  }
}
