export type RouteFamilyName = "shell" | "sessions" | "configuration" | "tailnet" | "operability" | "authority";
export type RouteMap<T> = Readonly<Record<string, T>>;

const OPERABILITY = new Set(["GET /api/health", "GET /api/metrics", "GET /metrics"]);
const AUTHORITY_PREFIXES = ["/api/auth/", "/api/push/", "/api/notify"];
const CONFIGURATION = new Set(["GET /api/providers", "GET /api/settings", "POST /api/settings", "GET /api/backend"]);
const TAILNET_PREFIXES = ["/api/tailnet/", "/api/discover"];
const SHELL = new Set(["GET /", "GET /manifest.json", "GET /api/info", "GET /api/machine", "GET /api/projects", "GET /api/next-session-name"]);

export function routeFamilyFor(key: string): RouteFamilyName {
  if (OPERABILITY.has(key)) return "operability";
  const path = key.slice(key.indexOf(" ") + 1);
  if (AUTHORITY_PREFIXES.some(prefix => path.startsWith(prefix))) return "authority";
  if (TAILNET_PREFIXES.some(prefix => path.startsWith(prefix))) return "tailnet";
  if (CONFIGURATION.has(key)) return "configuration";
  if (SHELL.has(key)) return "shell";
  return "sessions";
}

export function splitRouteFamilies<T>(routes: RouteMap<T>): Record<RouteFamilyName, Record<string, T>> {
  const families: Record<RouteFamilyName, Record<string, T>> = {
    shell: {}, sessions: {}, configuration: {}, tailnet: {}, operability: {}, authority: {},
  };
  for (const [key, handler] of Object.entries(routes)) families[routeFamilyFor(key)][key] = handler;
  return families;
}

export function composeRouteFamilies<T>(families: Readonly<Record<RouteFamilyName, RouteMap<T>>>): Record<string, T> {
  const combined: Record<string, T> = {};
  for (const family of Object.values(families)) {
    for (const [key, handler] of Object.entries(family)) {
      if (key in combined) throw new Error(`duplicate route across families: ${key}`);
      combined[key] = handler;
    }
  }
  return combined;
}
