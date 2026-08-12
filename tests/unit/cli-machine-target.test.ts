import { describe, expect, test } from "bun:test";
import {
  extractMachineSelector,
  resolveMachineOrigin,
  verifyMachineTarget,
} from "../../src/cli/machine-target.ts";
import { MACHINE_CAPABILITY } from "../../src/tailnet-machine-contract.ts";
import type { MachineHandshake } from "../../src/tailnet-machine-contract.ts";

const ORIGIN = "https://peer.example.ts.net";
const CONFIGURED_HOSTNAME = "local.example.ts.net";
const HANDSHAKE_LIMIT = 32 * 1024;

function handshake(origin = ORIGIN): MachineHandshake {
  return {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: {
      tailnetNodeId: "n-peer",
      installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
      displayName: "peer",
      origin,
    },
    wolfpack: { version: "1.7.0" },
    capabilities: [MACHINE_CAPABILITY.SESSIONS],
  };
}

function successfulResponse(value: unknown = handshake()): Response {
  return Response.json(value);
}

describe("global machine selector", () => {
  test("extracts exactly one leading global selector", () => {
    expect(extractMachineSelector(["--machine", "peer", "session", "status", "id", "--json"])).toEqual({
      ok: true,
      selector: "peer",
      argv: ["session", "status", "id", "--json"],
    });
    expect(extractMachineSelector(["list", "--json"])).toEqual({
      ok: true,
      selector: undefined,
      argv: ["list", "--json"],
    });
  });

  test.each([
    ["missing value", ["--machine"]],
    ["flag-shaped value", ["--machine", "--json", "list"]],
    ["duplicate selector", ["--machine", "peer", "--machine", "other", "list"]],
    ["equals form", ["--machine=peer", "list"]],
  ] as const)("rejects %s", (_name, argv) => {
    const parsed = extractMachineSelector(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("INVALID_MACHINE_SELECTOR");
  });

  test.each([
    ["non-leading pair", ["session", "send", "local-session", "--machine", "peer"]],
    ["non-leading equals form", ["session", "send", "local-session", "--machine=peer"]],
    ["later duplicate pair", ["--machine", "peer", "session", "send", "remote-session", "--machine", "other"]],
    ["later duplicate equals form", ["--machine", "peer", "session", "send", "remote-session", "--machine=other"]],
  ] as const)("rejects a %s anywhere outside the sole leading selector pair", (_name, argv) => {
    const parsed = extractMachineSelector(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("INVALID_MACHINE_SELECTOR");
  });
});

describe("machine origin resolution", () => {
  test("resolves a short name and a canonical same-tailnet fqdn", () => {
    expect(resolveMachineOrigin("peer", CONFIGURED_HOSTNAME)).toEqual({ ok: true, origin: ORIGIN });
    expect(resolveMachineOrigin("peer.example.ts.net", CONFIGURED_HOSTNAME)).toEqual({ ok: true, origin: ORIGIN });
  });

  test("derives the exact namespace from the configured hostname", () => {
    expect(resolveMachineOrigin("peer", "local.team-name.ts.net")).toEqual({
      ok: true,
      origin: "https://peer.team-name.ts.net",
    });
    expect(resolveMachineOrigin("peer.example.ts.net", "local.team-name.ts.net").ok).toBe(false);
  });

  test.each([
    ["url", "https://peer.example.ts.net"],
    ["port", "peer.example.ts.net:443"],
    ["path", "peer.example.ts.net/api"],
    ["malformed label", "bad_name"],
    ["empty label", "peer..example.ts.net"],
    ["foreign tailnet", "peer.foreign.ts.net"],
    ["non-canonical fqdn", "Peer.example.ts.net"],
  ] as const)("rejects a %s", (_name, selector) => {
    expect(resolveMachineOrigin(selector, CONFIGURED_HOSTNAME).ok).toBe(false);
  });

  test("rejects missing or invalid tailnet configuration", () => {
    expect(resolveMachineOrigin("peer", undefined).ok).toBe(false);
    expect(resolveMachineOrigin("peer", "local.ts.net").ok).toBe(false);
    expect(resolveMachineOrigin("peer", "https://local.example.ts.net").ok).toBe(false);
  });
});

describe("machine handshake verification", () => {
  test("probes the exact endpoint with jwt, redirects disabled, and returns structured identity", async () => {
    const calls: Array<{ readonly input: string; readonly init: RequestInit }> = [];
    const result = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      jwt: "signed-token",
      fetcher: async (input, init) => {
        calls.push({ input, init });
        return successfulResponse();
      },
    });

    expect(result).toEqual({
      ok: true,
      target: {
        kind: "remote",
        origin: ORIGIN,
        machine: handshake().machine,
      },
    });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer signed-token");
    expect(calls[0]).toMatchObject({
      input: `${ORIGIN}/api/machine`,
      init: {
        method: "GET",
        redirect: "error",
        headers: expect.any(Headers),
      },
    });
  });

  test.each([
    ["mismatched origin", handshake("https://other.example.ts.net")],
    ["incompatible protocol", { ...handshake(), protocol: { name: "wolfpack-machine", major: 2, minor: 0 } }],
    ["missing session capability", { ...handshake(), capabilities: [MACHINE_CAPABILITY.PUSH_SUBSCRIPTION] }],
    ["display prose", { name: "peer", url: ORIGIN }],
  ] as const)("rejects %s", async (_name, value) => {
    const result = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async () => successfulResponse(value),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INCOMPATIBLE_MACHINE");
  });

  test("rejects an oversized declared body without reading it", async () => {
    const response = new Response("x", {
      headers: { "content-length": String(HANDSHAKE_LIMIT + 1) },
    });
    const result = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async () => response,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_MACHINE_RESPONSE");
    expect(response.bodyUsed).toBe(false);
  });

  test("rejects and cancels an oversized chunked body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HANDSHAKE_LIMIT + 1));
      },
      cancel() {
        cancelled = true;
      },
    }));
    const result = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async () => response,
    });

    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("fails closed on redirects, timeouts, and unreachable peers", async () => {
    const redirect = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1" } }),
    });
    const timeout = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      timeoutMs: 10,
      fetcher: async () => new Promise<Response>(() => {}),
    });
    const unreachable = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async () => { throw new Error("connection refused"); },
    });

    expect(redirect.ok).toBe(false);
    expect(timeout.ok).toBe(false);
    expect(unreachable.ok).toBe(false);
  });

  test("never attempts localhost when explicit target verification fails", async () => {
    const urls: string[] = [];
    const result = await verifyMachineTarget("peer", {
      tailscaleHostname: CONFIGURED_HOSTNAME,
      fetcher: async (input) => {
        urls.push(input);
        throw new Error("unreachable");
      },
    });

    expect(result.ok).toBe(false);
    expect(urls).toEqual([`${ORIGIN}/api/machine`]);
    expect(urls.every((url) => !url.includes("127.0.0.1") && !url.includes("localhost"))).toBe(true);
  });
});
