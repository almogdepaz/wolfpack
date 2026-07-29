/**
 * Regression: sw.js open-redirect bypass via protocol-relative URL.
 *
 * The previous guard `if (url.startsWith("/"))` treated `//evil.com` as a
 * safe relative URL because it literally starts with `/`. Resolved against
 * the page origin, the browser navigates to `https://evil.com/`.
 *
 * Strategy here: load sw.js as CommonJS via the test-only export and
 * exercise sanitizeNotificationUrl against a battery of attack inputs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

// Load the service-worker file in a sandbox that satisfies the
// `if (typeof module !== "undefined")` test-export branch and stubs the
// `self` global the SW expects at top-level. We don't dispatch any events
// here — we just want the function reference.
const swSource = readFileSync(
  join(import.meta.dir, "..", "..", "public", "sw.js"),
  "utf-8",
);
const exportsObj: Record<string, unknown> = {};
const sandbox: Record<string, unknown> = {
  module: { exports: exportsObj },
  exports: exportsObj,
  self: { addEventListener: () => {}, registration: {}, location: {} },
  URL,
  console,
};
runInContext(swSource, createContext(sandbox), { filename: "sw.js" });
const { sanitizeNotificationUrl, routeNotificationClick } = (sandbox.module as {
  exports: {
    sanitizeNotificationUrl: (u: string, o: string) => string;
    routeNotificationClick: (
      clients: readonly { url: string; navigate?: (url: string) => Promise<unknown>; focus?: () => Promise<unknown> }[],
      url: string,
      origin: string,
      openWindow: (url: string) => Promise<unknown>,
    ) => Promise<unknown>;
  };
}).exports;

const ORIGIN = "https://wolfpack.example.com";

describe("sanitizeNotificationUrl — open-redirect protection", () => {
  // ── Same-origin happy paths ───────────────────────────────────────────
  test("preserves a plain absolute path", () => {
    expect(sanitizeNotificationUrl("/", ORIGIN)).toBe("/");
    expect(sanitizeNotificationUrl("/sessions", ORIGIN)).toBe("/sessions");
  });

  test("preserves query and fragment on same-origin URLs", () => {
    expect(sanitizeNotificationUrl("/s?x=1", ORIGIN)).toBe("/s?x=1");
    expect(sanitizeNotificationUrl("/s#frag", ORIGIN)).toBe("/s#frag");
    expect(sanitizeNotificationUrl("/s?x=1#frag", ORIGIN)).toBe("/s?x=1#frag");
  });

  test("preserves a fully-qualified same-origin URL", () => {
    expect(sanitizeNotificationUrl(`${ORIGIN}/abc`, ORIGIN)).toBe("/abc");
  });

  // ── The bug we're fixing ──────────────────────────────────────────────
  test("REGRESSION: protocol-relative //host is rejected", () => {
    // Pre-fix: `"//evil.com".startsWith("/")` → true → returned as-is →
    // clients.openWindow("//evil.com") → browser navigates to evil.com.
    expect(sanitizeNotificationUrl("//evil.com", ORIGIN)).toBe("/");
    expect(sanitizeNotificationUrl("//evil.com/path", ORIGIN)).toBe("/");
    expect(sanitizeNotificationUrl("//evil.com:8080/?q=1", ORIGIN)).toBe("/");
  });

  test("REGRESSION: backslash variants don't slip through", () => {
    // Some URL parsers treat backslashes as forward slashes.
    expect(sanitizeNotificationUrl("/\\evil.com", ORIGIN)).toBe("/");
    expect(sanitizeNotificationUrl("\\\\evil.com", ORIGIN)).toBe("/");
  });

  // ── Other cross-origin shapes ─────────────────────────────────────────
  test("rejects an absolute http URL on a different host", () => {
    expect(sanitizeNotificationUrl("https://evil.com/", ORIGIN)).toBe("/");
    expect(sanitizeNotificationUrl("http://evil.com/", ORIGIN)).toBe("/");
  });

  test("rejects javascript: pseudo-protocol", () => {
    expect(sanitizeNotificationUrl("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  test("rejects data: URIs", () => {
    expect(sanitizeNotificationUrl("data:text/html,<script>x</script>", ORIGIN)).toBe("/");
  });

  test("rejects port-only same-host change", () => {
    // Same hostname but different port = different origin.
    expect(sanitizeNotificationUrl("https://wolfpack.example.com:9999/", ORIGIN)).toBe("/");
  });

  test("rejects scheme downgrade (https → http on same host)", () => {
    expect(sanitizeNotificationUrl("http://wolfpack.example.com/", ORIGIN)).toBe("/");
  });

  // ── Malformed / pathological inputs ────────────────────────────────────
  test("returns / on garbage input", () => {
    expect(sanitizeNotificationUrl("not a url at all", ORIGIN)).toBe("/not%20a%20url%20at%20all");
    // (Note: relative-resolution of a bare token is treated as a path —
    // that's safe because it stays on the same origin. The point is it
    // doesn't escape origin.)
  });

  test("returns / on inputs that throw", () => {
    // URL constructor will throw on truly malformed input; sanitizer
    // must catch and return "/".
    expect(sanitizeNotificationUrl("http://[invalid:::ipv6]/", ORIGIN)).toBe("/");
  });
});

describe("notification click routing", () => {
  test("navigates an existing same-origin client to the session route before focusing it", async () => {
    const calls: string[] = [];
    const client = {
      url: `${ORIGIN}/#settings-general`,
      navigate: async (url: string) => { calls.push(`navigate:${url}`); },
      focus: async () => { calls.push("focus"); },
    };

    await routeNotificationClick([client], "/?sessionId=stable-id&machine=local", ORIGIN, async () => {
      calls.push("open");
    });

    expect(calls).toEqual([
      `navigate:${ORIGIN}/?sessionId=stable-id&machine=local`,
      "focus",
    ]);
  });

  test("opens the routed URL when no same-origin client exists", async () => {
    const opened: string[] = [];
    await routeNotificationClick(
      [{ url: "https://other.example/", focus: async () => {} }],
      "/?sessionId=stable-id&machine=local",
      ORIGIN,
      async (url) => { opened.push(url); },
    );
    expect(opened).toEqual([`${ORIGIN}/?sessionId=stable-id&machine=local`]);
  });
});
