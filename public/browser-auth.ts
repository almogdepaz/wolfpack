import { showAppDialog } from "./app-dialog";
import { fetchWithTimeout } from "./fetch-timeout";

const STORAGE_KEY = "wpAuthTokens:v1";

function scopeFor(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : input.toString();
  return new URL(raw, location.href).origin;
}

function loadTokens(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function saveTokens(tokens: Readonly<Record<string, string>>): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function getBrowserAuthToken(input: RequestInfo | URL): string | null {
  const scope = scopeFor(input);
  const tokens = loadTokens();
  if (tokens[scope]) return tokens[scope];
  // Migrate the historical long-lived token into private tab-scoped storage.
  const legacy = localStorage.getItem("wpJwt");
  if (legacy && scope === location.origin) {
    setBrowserAuthToken(input, legacy);
    localStorage.removeItem("wpJwt");
    return legacy;
  }
  return null;
}

export function setBrowserAuthToken(input: RequestInfo | URL, token: string | null): void {
  const scope = scopeFor(input);
  const tokens = loadTokens();
  if (token) tokens[scope] = token.trim();
  else delete tokens[scope];
  saveTokens(tokens);
}

export async function browserAuthFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getBrowserAuthToken(input);
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

let authPrompt: Promise<boolean> | null = null;

async function promptForBrowserCredential(input: RequestInfo | URL): Promise<boolean> {
  if (authPrompt) return authPrompt;
  authPrompt = (async () => {
    const target = input instanceof Request ? input.url : input.toString();
    const origin = new URL(target, location.href).origin;
    const result = await showAppDialog({
      title: "Authentication required",
      message: `Enter the access token for ${origin}. It is kept only in this browser tab.`,
      fields: [{ name: "token", label: "Access token" }],
      confirmLabel: "Authenticate",
    });
    const token = result?.token?.trim();
    if (!token) return false;
    setBrowserAuthToken(input, token);
    return true;
  })().finally(() => { authPrompt = null; });
  return authPrompt;
}

/** Timed browser request with per-origin bearer auth and one interactive retry. */
export async function authenticatedFetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  let response = await fetchWithTimeout(input, init, undefined, browserAuthFetch);
  if (response.status === 401 && await promptForBrowserCredential(input)) {
    response = await fetchWithTimeout(input, init, undefined, browserAuthFetch);
  }
  return response;
}
