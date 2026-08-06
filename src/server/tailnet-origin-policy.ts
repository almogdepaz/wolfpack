import { canonicalTailnetOrigin } from "../tailnet-machine-contract.js";

export interface TailnetOriginPolicyOptions {
  readonly port: number;
  readonly tailscaleHostname: string | undefined;
  readonly testMode: boolean;
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
 * authority; Origin is only compared against this persisted fact.
 */
export function createTailnetOriginPolicy(options: TailnetOriginPolicyOptions): { isAllowed(origin: string): boolean } {
  const localOrigins = new Set([
    `http://localhost:${options.port}`,
    `http://127.0.0.1:${options.port}`,
  ]);
  const configuredOrigin = canonicalTailnetOrigin(options.tailscaleHostname);
  const tailnetSuffix = configuredOrigin?.slice("https://".length).split(".").slice(1).join(".");

  return {
    isAllowed(origin: string): boolean {
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
    },
  };
}
