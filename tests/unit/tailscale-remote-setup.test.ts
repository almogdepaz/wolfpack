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

  test("does not report success when serve exits successfully without the expected route", () => {
    const calls: (readonly string[])[] = [];
    const result = configureTailscaleRemoteAccess({
      binary: "tailscale",
      port: 18790,
      run: (_file, args) => {
        calls.push(args);
        if (args[0] === "status") return JSON.stringify({ Self: { DNSName: `${HOSTNAME}.` } });
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
