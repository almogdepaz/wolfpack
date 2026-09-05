import { describe, expect, test } from "bun:test";
import {
  MACHINE_CAPABILITY,
  TAILNET_MAX_CANDIDATES,
  buildMachineHandshake,
  candidateEnumerationCandidates,
  classifyMachineHandshake,
  enumerateTailnetCandidates,
} from "../../src/tailnet-machine-contract.ts";

const installationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
const candidate = {
  hostname: "peer.example.ts.net",
  tailnetNodeId: "n-peer",
  origin: "https://peer.example.ts.net",
  online: true,
};

const readyHandshake = {
  protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
  machine: {
    tailnetNodeId: candidate.tailnetNodeId,
    installationId,
    displayName: "peer",
    origin: candidate.origin,
  },
  wolfpack: { version: "1.7.0" },
  capabilities: [
    MACHINE_CAPABILITY.SESSIONS,
    MACHINE_CAPABILITY.TERMINAL_WEBSOCKET,
    MACHINE_CAPABILITY.PUSH_SUBSCRIPTION,
  ],
} as const;

describe("machine handshake contract", () => {
  test("builds a non-sensitive handshake only from verified local Tailnet facts", () => {
    expect(buildMachineHandshake({
      tailscaleHostname: "local.example.ts.net.",
      tailscaleNodeId: "n-local",
      installationId,
      displayName: "local",
      version: "1.7.0",
    })).toEqual({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-local",
        installationId,
        displayName: "local",
        origin: "https://local.example.ts.net",
      },
      wolfpack: { version: "1.7.0" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    });
  });

  test("rejects malformed self-identification and non-canonical origins", () => {
    const complete = {
      tailscaleHostname: "local.example.ts.net",
      tailscaleNodeId: "n-local",
      installationId,
      displayName: "local",
      version: "1.7.0",
    };

    expect(buildMachineHandshake({ ...complete, tailscaleNodeId: undefined })).toBeNull();
    expect(buildMachineHandshake({ ...complete, installationId: "not-a-uuid" })).toBeNull();
    expect(buildMachineHandshake({ ...complete, tailscaleHostname: "https://evil.example" })).toBeNull();
    expect(buildMachineHandshake({ ...complete, tailscaleHostname: "local..example.ts.net" })).toBeNull();
    expect(buildMachineHandshake({ ...complete, displayName: "bad\u0000name" })).toBeNull();
  });

  test("accepts forward-compatible minor data but rejects unsupported majors and capabilities", () => {
    expect(classifyMachineHandshake(candidate, {
      ...readyHandshake,
      protocol: { ...readyHandshake.protocol, minor: 99, futureProtocolField: "allowed" },
      capabilities: [...readyHandshake.capabilities, "future-capability"],
      futureField: { allowed: true },
    })).toEqual({ kind: "ready", handshake: { ...readyHandshake, protocol: { ...readyHandshake.protocol, minor: 99 } } });

    expect(classifyMachineHandshake(candidate, {
      ...readyHandshake,
      protocol: { ...readyHandshake.protocol, major: 2 },
    })).toEqual({ kind: "incompatible" });
    expect(classifyMachineHandshake(candidate, {
      ...readyHandshake,
      capabilities: [MACHINE_CAPABILITY.SESSIONS],
    })).toEqual({ kind: "incompatible" });
  });

  test("rejects peer node-id and canonical-origin mismatches", () => {
    expect(classifyMachineHandshake(candidate, {
      ...readyHandshake,
      machine: { ...readyHandshake.machine, tailnetNodeId: "n-other" },
    })).toEqual({ kind: "incompatible" });
    expect(classifyMachineHandshake(candidate, {
      ...readyHandshake,
      machine: { ...readyHandshake.machine, origin: "https://other.example.ts.net" },
    })).toEqual({ kind: "incompatible" });
  });

  test("accepts browser candidate-enumeration envelopes with canonical candidates", () => {
    const browserCandidate = { ...candidate, tailnetNodeId: "" };

    expect(candidateEnumerationCandidates({ candidates: [candidate, browserCandidate] })).toEqual([
      candidate,
      browserCandidate,
    ]);
  });

  test("preserves candidate-enumeration unavailable error envelopes", () => {
    expect(() => candidateEnumerationCandidates({ candidates: [], error: "failed to query tailscale" }))
      .toThrow("failed to query tailscale");
    expect(() => candidateEnumerationCandidates({ error: "" }))
      .toThrow("tailnet candidate enumeration unavailable");
    expect(() => candidateEnumerationCandidates({ error: {} }))
      .toThrow("tailnet candidate enumeration unavailable");
  });

  test("rejects malformed browser candidate-enumeration envelopes and candidates", () => {
    for (const response of [
      null,
      [],
      {},
      { candidates: {} },
      { candidates: [{ ...candidate, origin: "https://other.example.ts.net" }] },
      { candidates: [{ ...candidate, online: "true" }] },
    ]) {
      expect(() => candidateEnumerationCandidates(response)).toThrow("tailnet candidate enumeration response is malformed");
    }
  });

  test("distinguishes invalid local Tailnet status from a valid empty peer set", () => {
    const validSelf = { ID: "n-local", DNSName: "local.example.ts.net." };

    expect(enumerateTailnetCandidates({ Self: validSelf, Peer: {} })).toEqual({ kind: "valid", candidates: [] });
    for (const status of [
      null,
      {},
      { Self: null, Peer: {} },
      { Self: { ...validSelf, ID: "" }, Peer: {} },
      { Self: validSelf, Peer: [] },
    ]) {
      expect(enumerateTailnetCandidates(status)).toEqual({ kind: "invalid-local-status" });
    }
  });

  test("enumerates valid online and offline Tailnet candidates while skipping unknown or malformed entries", () => {
    expect(enumerateTailnetCandidates({
      Self: { ID: "n-local", DNSName: "local.example.ts.net." },
      Peer: {
        "n-peer": { ID: "n-peer", DNSName: "peer.example.ts.net.", Online: true },
        "n-offline": { ID: "n-offline", DNSName: "offline.example.ts.net.", Online: false },
        "n-unknown": { ID: "n-unknown", DNSName: "unknown.example.ts.net.", Online: "unknown" },
        "n-malformed": { ID: "", DNSName: "https://evil.example", Online: true },
        "n-self": { ID: "n-local", DNSName: "local.example.ts.net.", Online: true },
      },
    })).toEqual({
      kind: "valid",
      candidates: [
        candidate,
        { hostname: "offline.example.ts.net", tailnetNodeId: "n-offline", origin: "https://offline.example.ts.net", online: false },
      ],
    });
  });

  test("selects the bounded online-first candidate set independently of Tailnet JSON order", () => {
    const online = Array.from({ length: TAILNET_MAX_CANDIDATES }, (_, index) => {
      const id = `n-online-${String(index).padStart(2, "0")}`;
      return [`online-${id}`, { ID: id, DNSName: `online-${id}.example.ts.net.`, Online: true }] as const;
    });
    const offline = Array.from({ length: 2 }, (_, index) => {
      const id = `n-offline-${String(index).padStart(2, "0")}`;
      return [`offline-${id}`, { ID: id, DNSName: `offline-${id}.example.ts.net.`, Online: false }] as const;
    });
    const duplicateOffline = ["duplicate-online-00", {
      ID: "n-online-00",
      DNSName: "duplicate.example.ts.net.",
      Online: false,
    }] as const;
    const entries = [...offline, duplicateOffline, ...online];
    const enumerate = (peerEntries: readonly (readonly [string, object])[]) => enumerateTailnetCandidates({
      Self: { ID: "n-local", DNSName: "local.example.ts.net." },
      Peer: Object.fromEntries(peerEntries),
    });

    const first = enumerate(entries);
    const reversed = enumerate([...entries].reverse());
    expect(first).toEqual(reversed);
    expect(first.kind).toBe("valid");
    if (first.kind !== "valid") throw new Error("expected valid local Tailnet status");
    expect(first.candidates).toHaveLength(TAILNET_MAX_CANDIDATES);
    expect(first.candidates.map((candidate) => candidate.tailnetNodeId)).toEqual(
      online.map(([_, peer]) => peer.ID).sort((left, right) => left.localeCompare(right)),
    );
    expect(first.candidates.find((candidate) => candidate.tailnetNodeId === "n-online-00")).toEqual({
      hostname: "online-n-online-00.example.ts.net",
      tailnetNodeId: "n-online-00",
      origin: "https://online-n-online-00.example.ts.net",
      online: true,
    });
  });
});
