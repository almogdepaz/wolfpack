/**
 * Regression test for HIGH finding in .context/reports/issues.md:
 * "sw-push.js open-redirect bypass via protocol-relative URL".
 *
 * The previous guard `if (url.startsWith("/"))` treated `//evil.com` as a
 * safe relative URL because it literally starts with `/`. Resolved against
 * the page origin, the browser navigates to `https://evil.com/`.
 *
 * Strategy here: load sw-push.js as CommonJS via the test-only export and
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
  join(import.meta.dir, "..", "..", "public", "sw-push.js"),
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
runInContext(swSource, createContext(sandbox), { filename: "sw-push.js" });
const { sanitizeNotificationUrl } = (sandbox.module as { exports: { sanitizeNotificationUrl: (u: string, o: string) => string } }).exports;

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
