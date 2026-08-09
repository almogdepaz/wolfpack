import { describe, expect, test } from "bun:test";
import { createTailnetOriginPolicy } from "../../src/server/tailnet-origin-policy.js";

const port = 18790;
const local = `http://localhost:${port}`;
const peer = "https://phone.tailnet.ts.net";

describe("Tailnet browser origin policy", () => {
  const policy = createTailnetOriginPolicy({
    port,
    tailscaleHostname: "workstation.tailnet.ts.net",
    testMode: false,
  });

  test("allows explicit local development and canonical sibling Tailnet origins", () => {
    expect(policy.isAllowed(local)).toBe(true);
    expect(policy.isAllowed(peer)).toBe(true);
  });

  test("rejects raw addresses, non-canonical forms, and suffix lookalikes", () => {
    for (const origin of [
      "http://phone.tailnet.ts.net",
      "https://phone.tailnet.ts.net:443",
      "https://phone.tailnet.ts.net.evil.example",
      "https://phone.tailnet.ts.net@evil.example",
      "https://evil.example",
      "https://127.0.0.1",
      "https://tailnet.ts.net",
    ]) {
      expect(policy.isAllowed(origin)).toBe(false);
    }
  });

  test("does not enable remote origins from malformed or unverified config", () => {
    const policyWithoutVerifiedIdentity = createTailnetOriginPolicy({
      port,
      tailscaleHostname: "https://evil.example",
      testMode: false,
    });
    expect(policyWithoutVerifiedIdentity.isAllowed(peer)).toBe(false);
  });
});
