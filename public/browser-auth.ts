import { showAppDialog } from "./app-dialog";
import { fetchWithTimeout } from "./fetch-timeout";
import type { FetchLike } from "./fetch-timeout";

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

interface CredentialPrompt {
  readonly controller: AbortController;
  readonly owners: Set<symbol>;
  readonly result: Promise<boolean>;
}
const credentialPrompts = new Map<string, CredentialPrompt>();
// Only credential prompts share this queue; the application dialog stays single-occupancy.
let credentialPromptTail: Promise<void> = Promise.resolve();

function promptForBrowserCredential(input: RequestInfo | URL, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const origin = scopeFor(input);
  let prompt = credentialPrompts.get(origin);
  if (!prompt) {
    const controller = new AbortController();
    const owners = new Set<symbol>();
    const result = credentialPromptTail.then(async () => {
      if (controller.signal.aborted) return false;
      const credential = await showAppDialog({
        title: "Authentication required",
        message: `Enter the access token for ${origin}. It is kept only in this browser tab.`,
        fields: [{ name: "token", label: "Access token" }],
        confirmLabel: "Authenticate",
        signal: controller.signal,
      });
      const token = credential?.token?.trim();
      if (!token || controller.signal.aborted) return false;
      setBrowserAuthToken(input, token);
      return true;
    }).finally(() => {
      if (credentialPrompts.get(origin)?.controller === controller) credentialPrompts.delete(origin);
    });
    prompt = { controller, owners, result };
    credentialPrompts.set(origin, prompt);
    credentialPromptTail = result.then(() => undefined, () => undefined);
  }
  const shared = prompt;
  const owner = Symbol();
  shared.owners.add(owner);
  return new Promise<boolean>((resolve, reject) => {
    const release = (): void => {
      signal?.removeEventListener("abort", abort);
      if (!shared.owners.delete(owner)) return;
      if (shared.owners.size === 0) {
        shared.controller.abort();
        if (credentialPrompts.get(origin) === shared) credentialPrompts.delete(origin);
      }
    };
    const abort = (): void => { release(); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    shared.result.then(accepted => { release(); resolve(accepted); }, error => { release(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export interface BrowserAuthenticatedFetchDependencies {
  readonly timedFetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
    timeoutMs?: number,
    fetchImpl?: FetchLike,
  ) => Promise<Response>;
  readonly authFetch?: FetchLike;
  readonly promptForCredential?: (input: RequestInfo | URL, signal?: AbortSignal) => Promise<boolean>;
  /** Background reads must report 401 without acquiring user credentials. */
  readonly interactive?: boolean;
}

/** Timed browser request with per-origin bearer auth and one interactive retry. */
export async function authenticatedFetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  dependencies: BrowserAuthenticatedFetchDependencies = {},
): Promise<Response> {
  const timedFetch = dependencies.timedFetch ?? fetchWithTimeout;
  const authFetch = dependencies.authFetch ?? browserAuthFetch;
  const promptForCredential = dependencies.promptForCredential ?? promptForBrowserCredential;
  init.signal?.throwIfAborted();
  let response = await timedFetch(input, init, undefined, authFetch);
  if (response.status === 401 && dependencies.interactive !== false) {
    init.signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (!init.signal) return;
        onAbort = () => reject(init.signal!.reason);
        init.signal.addEventListener("abort", onAbort, { once: true });
      });
      const accepted = await Promise.race([promptForCredential(input, init.signal ?? undefined), cancelled]);
      init.signal?.throwIfAborted();
      if (accepted) response = await timedFetch(input, init, undefined, authFetch);
    } finally {
      if (onAbort) init.signal?.removeEventListener("abort", onAbort);
    }
  }
  return response;
}
