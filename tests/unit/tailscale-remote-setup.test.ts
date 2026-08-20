import { describe, expect, test } from "bun:test";
import {
  configureTailscaleRemoteAccess,
  parseTailscaleHostname,
  verifiesTailscaleServe,
} from "../../src/cli/tailscale-remote-setup.js";

const HOSTNAME = "workbox.tailnet.ts.net";

function serveStatus(proxy = "http://127.0.0.1:18790"): string {
  return JSON.stringify({
    Web: {
      [`${HOSTNAME}:443`]: { Handlers: { "/": { Proxy: proxy } } },
    },
  });
}

describe("tailscale remote setup", () => {
  test("uses the canonical hostname and verifies the structured serve route", () => {
    expect(parseTailscaleHostname(JSON.stringify({ Self: { DNSName: `${HOSTNAME}.` } }))).toBe(HOSTNAME);
    expect(verifiesTailscaleServe(serveStatus(), HOSTNAME, 18790)).toBe(true);
  });

  test("rejects missing or mismatched structured serve routes", () => {
    expect(verifiesTailscaleServe(JSON.stringify({ Web: {} }), HOSTNAME, 18790)).toBe(false);
    expect(verifiesTailscaleServe(serveStatus("http://127.0.0.1:9999"), HOSTNAME, 18790)).toBe(false);
  });

  test("reports verified only after the canonical origin's exact local route is present", () => {
    const calls: (readonly string[])[] = [];
    const result = configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => {
        calls.push(args);
        if (args[0] === "status") return JSON.stringify({ Self: { DNSName: `${HOSTNAME}.` } });
        if (args[0] === "serve" && args[1] === "status") return serveStatus();
        return "";
      },
    });

    expect(result).toEqual({ status: "verified", hostname: HOSTNAME, origin: `https://${HOSTNAME}` });
    expect(calls).toEqual([
      ["status", "--self", "--json"],
      ["serve", "--bg", "18790"],
      ["serve", "status", "--json"],
    ]);
  });

  test("stops before Serve configuration for unusable identity states", () => {
    for (const [statusOutput, expected] of [
      [JSON.stringify({}), { status: "logged-out" }],
      [JSON.stringify({ Self: {} }), { status: "logged-out" }],
      ["not json", { status: "malformed-status" }],
    ] as const) {
      const calls: (readonly string[])[] = [];
      const result = configureTailscaleRemoteAccess({
        binary: "tailscale",
        port: 18790,
        run: (_file, args) => {
          calls.push(args);
          return statusOutput;
        },
      });

      expect(result).toEqual(expected);
      expect(calls).toEqual([["status", "--self", "--json"]]);
    }

    const calls: (readonly string[])[] = [];
    const unavailable = configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => {
        calls.push(args);
        throw new Error("tailscaled unavailable");
      },
    });
    expect(unavailable).toEqual({ status: "unavailable" });
    expect(calls).toEqual([["status", "--self", "--json"]]);
  });

  test("does not report readiness for malformed or mismatched serve status", () => {
    const configure = (serve: string) => configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => args[0] === "status"
        ? JSON.stringify({ Self: { DNSName: `${HOSTNAME}.` } })
        : args[1] === "status" ? serve : "",
    });

    expect(configure("not json")).toEqual({ status: "serve-unverified" });
    expect(configure(serveStatus("http://127.0.0.1:9999"))).toEqual({ status: "serve-unverified" });
  });
});
