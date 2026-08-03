import { describe, expect, test } from "bun:test";
import {
  configureTailscaleRemoteAccess,
  parseTailscaleHostname,
  parseTailscaleMachineIdentity,
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
  test("uses Tailscale's canonical hostname and node id", () => {
    const status = JSON.stringify({ Self: { DNSName: `${HOSTNAME}.`, ID: "n123" } });
    expect(parseTailscaleHostname(status)).toBe(HOSTNAME);
    expect(parseTailscaleMachineIdentity(status)).toEqual({ hostname: HOSTNAME, nodeId: "n123" });
    expect(verifiesTailscaleServe(serveStatus(), HOSTNAME, 18790)).toBe(true);
  });

  test("rejects a status document without a node id", () => {
    expect(parseTailscaleMachineIdentity(JSON.stringify({ Self: { DNSName: HOSTNAME } }))).toBeUndefined();
  });

  test("rejects missing or mismatched structured serve routes", () => {
    expect(verifiesTailscaleServe(JSON.stringify({ Web: {} }), HOSTNAME, 18790)).toBe(false);
    expect(verifiesTailscaleServe(serveStatus("http://127.0.0.1:9999"), HOSTNAME, 18790)).toBe(false);
  });

  test("returns the stable node id only after Serve verification", () => {
    const result = configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => {
        if (args[0] === "status") return JSON.stringify({ Self: { DNSName: `${HOSTNAME}.`, ID: "n123" } });
        if (args[0] === "serve" && args[1] === "status") return serveStatus();
        return "";
      },
    });

    expect(result).toEqual({ status: "verified", hostname: HOSTNAME, nodeId: "n123" });
  });

  test("does not report success when serve exits successfully without the expected route", () => {
    const calls: (readonly string[])[] = [];
    const result = configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => {
        calls.push(args);
        if (args[0] === "status") return JSON.stringify({ Self: { DNSName: `${HOSTNAME}.`, ID: "n123" } });
        if (args[0] === "serve" && args[1] === "status") return JSON.stringify({ Web: {} });
        return "";
      },
    });

    expect(result).toEqual({ status: "unverified" });
    expect(calls).toEqual([
      ["status", "--self", "--json"],
      ["serve", "--bg", "18790"],
      ["serve", "status", "--json"],
    ]);
  });
});
