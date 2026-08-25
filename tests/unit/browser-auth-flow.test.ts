import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  authenticatedFetchWithTimeout,
  browserAuthFetch,
  getBrowserAuthToken,
  setBrowserAuthToken,
} from "../../public/browser-auth.ts";

class MemoryStorage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function setGlobal(name: "location" | "sessionStorage" | "localStorage" | "fetch", value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreGlobal(name: "location" | "sessionStorage" | "localStorage" | "fetch", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

describe("browser authentication flow", () => {
  beforeEach(() => {
    setGlobal("location", new URL("https://local.test/app"));
    setGlobal("sessionStorage", new MemoryStorage());
    setGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    restoreGlobal("location", originalLocation);
    restoreGlobal("sessionStorage", originalSessionStorage);
    restoreGlobal("localStorage", originalLocalStorage);
    restoreGlobal("fetch", originalFetch);
  });

  test("keeps session tokens isolated by request origin", () => {
    setBrowserAuthToken("/api/sessions", " local-token ");
    setBrowserAuthToken("https://remote.test/api/sessions", "remote-token");

    expect(getBrowserAuthToken("https://local.test/api/status")).toBe("local-token");
    expect(getBrowserAuthToken("https://remote.test/api/status")).toBe("remote-token");
    expect(getBrowserAuthToken("https://other.test/api/status")).toBeNull();
  });

  test("migrates and removes the legacy localStorage token only for the same origin", () => {
    localStorage.setItem("wpJwt", "legacy-token");

    expect(getBrowserAuthToken("https://remote.test/api/status")).toBeNull();
    expect(localStorage.getItem("wpJwt")).toBe("legacy-token");

    expect(getBrowserAuthToken("/api/status")).toBe("legacy-token");
    expect(localStorage.getItem("wpJwt")).toBeNull();
    expect(getBrowserAuthToken("https://local.test/api/other")).toBe("legacy-token");
  });

  test("injects bearer auth unless the caller already supplied Authorization", async () => {
    const authorizations: Array<string | null> = [];
    setGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return new Response("ok");
    });
    setBrowserAuthToken("/api/status", "scoped-token");

    await browserAuthFetch("/api/status");
    await browserAuthFetch("/api/status", { headers: { Authorization: "Basic caller" } });

    expect(authorizations).toEqual(["Bearer scoped-token", "Basic caller"]);
  });

  test("retries one authenticated request after a 401 credential prompt", async () => {
    const statuses = [401, 200];
    const requests: string[] = [];
    let prompts = 0;

    const response = await authenticatedFetchWithTimeout("/api/status", {}, {
      timedFetch: async (input) => {
        requests.push(input.toString());
        return new Response(null, { status: statuses.shift() ?? 500 });
      },
      promptForCredential: async () => {
        prompts++;
        return true;
      },
    });

    expect(response.status).toBe(200);
    expect(prompts).toBe(1);
    expect(requests).toEqual(["/api/status", "/api/status"]);
  });

  test("does not retry a 401 when the credential prompt is declined", async () => {
    const requests: string[] = [];
    let prompts = 0;

    const response = await authenticatedFetchWithTimeout("/api/status", {}, {
      timedFetch: async (input) => {
        requests.push(input.toString());
        return new Response(null, { status: 401 });
      },
      promptForCredential: async () => {
        prompts++;
        return false;
      },
    });

    expect(response.status).toBe(401);
    expect(prompts).toBe(1);
    expect(requests).toEqual(["/api/status"]);
  });
});
