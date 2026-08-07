import { canonicalTailnetOrigin } from "../tailnet-machine-contract.js";

export interface TailnetOriginPolicyOptions {
  readonly port: number;
  readonly tailscaleHostname: string | undefined;
  readonly testMode: boolean;
}

interface TailnetServeHeaders {
  readonly referer?: string | string[];
  readonly "tailscale-user-login"?: string | string[];
}

function canonicalBrowserTailnetOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const canonical = canonicalTailnetOrigin(url.hostname);
    return canonical === origin ? canonical : null;
  } catch {
    return null;
  }
}

/**
 * Limits browser cross-origin access to canonical Tailnet machine origins
 * derived from setup's verified local identity. Tailscale's injected login
 * header only authorizes recovery after Serve strips Origin; it never supplies
 * origin authority.
 */
export function createTailnetOriginPolicy(options: TailnetOriginPolicyOptions): {
  isAllowed(origin: string): boolean;
  recoverServeOrigin(headers: TailnetServeHeaders): string | undefined;
} {
  const localOrigins = new Set([
    `http://localhost:${options.port}`,
    `http://127.0.0.1:${options.port}`,
  ]);
  const configuredOrigin = canonicalTailnetOrigin(options.tailscaleHostname);
  const tailnetSuffix = configuredOrigin?.slice("https://".length).split(".").slice(1).join(".");

  const isAllowed = (origin: string): boolean => {
    if (localOrigins.has(origin)) return true;
    if (options.testMode) {
      try {
        const url = new URL(origin);
        if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === origin) return true;
      } catch { /* malformed test origin */ }
    }
    if (!tailnetSuffix) return false;
    const canonicalOrigin = canonicalBrowserTailnetOrigin(origin);
    if (!canonicalOrigin) return false;
    const hostname = canonicalOrigin.slice("https://".length);
    return hostname.endsWith(`.${tailnetSuffix}`) && hostname.length > tailnetSuffix.length + 1;
  };

  return {
    isAllowed,
    recoverServeOrigin(headers: TailnetServeHeaders): string | undefined {
      const login = headers["tailscale-user-login"];
      const referer = headers.referer;
      if (typeof login !== "string" || login.trim().length === 0 || typeof referer !== "string") return undefined;
      try {
        const origin = new URL(referer).origin;
        return isAllowed(origin) ? origin : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
