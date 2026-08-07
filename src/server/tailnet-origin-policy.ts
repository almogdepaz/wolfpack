import { canonicalTailnetOrigin } from "../tailnet-machine-contract.js";

export interface TailnetOriginPolicyOptions {
  readonly port: number;
  readonly tailscaleHostname: string | undefined;
  readonly testMode: boolean;
}

export interface TailscaleServeOriginInput {
  readonly fromLoopback: boolean;
  readonly tailscaleUserLogin: string | readonly string[] | undefined;
  readonly referer: string | undefined;
}

export interface TailnetOriginPolicy {
  isAllowed(origin: string): boolean;
  recoverTailscaleServeOrigin(input: TailscaleServeOriginInput): string | undefined;
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
 * derived from setup's verified local identity. No request header supplies
 * authority; recovery from a stripped Origin requires local Tailscale Serve
 * identity headers plus a canonical sibling Referer.
 */
export function createTailnetOriginPolicy(options: TailnetOriginPolicyOptions): TailnetOriginPolicy {
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
    recoverTailscaleServeOrigin(input: TailscaleServeOriginInput): string | undefined {
      if (!input.fromLoopback) return undefined;
      if (typeof input.tailscaleUserLogin !== "string" || input.tailscaleUserLogin.trim().length === 0) return undefined;
      if (!input.referer || !tailnetSuffix) return undefined;
      try {
        const refererOrigin = new URL(input.referer).origin;
        // Recovery is Tailnet-only: local/test origins never become Serve authority.
        if (!canonicalBrowserTailnetOrigin(refererOrigin)) return undefined;
        return isAllowed(refererOrigin) ? refererOrigin : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
