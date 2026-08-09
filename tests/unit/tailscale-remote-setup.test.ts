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

  test("distinguishes logged-out, malformed, and unavailable Tailscale states", () => {
    const configure = (run: (_file: string, args: readonly string[]) => string) => configureTailscaleRemoteAccess({
      binary: "tailscale", port: 18790, run,
    });

    expect(configure(() => JSON.stringify({}))).toEqual({ status: "logged-out" });
    expect(configure(() => JSON.stringify({ Self: {} }))).toEqual({ status: "logged-out" });
    expect(configure(() => "not json")).toEqual({ status: "malformed-status" });
    expect(configure(() => { throw new Error("tailscaled unavailable"); })).toEqual({ status: "unavailable" });
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
