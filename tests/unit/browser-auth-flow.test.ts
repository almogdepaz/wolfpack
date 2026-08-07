import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");
const auth = readFileSync(join(import.meta.dir, "../../public/browser-auth.ts"), "utf8");
const appState = readFileSync(join(import.meta.dir, "../../public/app-state.ts"), "utf8");

describe("browser authentication flow", () => {
  test("centralizes API credentials and gives 401 an explicit dialog", () => {
    expect(app).toContain("authenticatedFetchWithTimeout(base, opts)");
    expect(auth).toContain('title: "Authentication required"');
    expect(auth).toContain("fetchWithTimeout(input, init, undefined, browserAuthFetch)");
    expect(auth).toContain('sessionStorage.setItem(STORAGE_KEY');
    expect(auth).toContain('localStorage.removeItem("wpJwt")');
  });

  test("uses authenticated timed fetches for every push API request", () => {
    for (const route of ["vapid-key", "subscribe", "unsubscribe"]) {
      expect(appState).toMatch(new RegExp(
        `authenticatedFetchWithTimeout\\(sameOriginPushUrl\\(location\\.origin, "/api/push/${route}"\\)`,
      ));
    }
    expect(appState).not.toMatch(/\bfetch\(sameOriginPushUrl\(location\.origin, "\/api\/push\//);
  });

  test("uses a short-lived ticket instead of putting JWTs in browser WebSocket URLs", () => {
    expect(app).toContain('target.searchParams.set("ticket", ticket)');
    expect(app).not.toContain('target.searchParams.set("token"');
  });
});
