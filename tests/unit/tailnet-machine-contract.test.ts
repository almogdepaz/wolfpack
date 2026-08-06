import { describe, expect, test } from "bun:test";
import {
  MACHINE_CAPABILITY,
  buildMachineHandshake,
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
        { hostname: "offline.example.ts.net", tailnetNodeId: "n-offline", origin: "https://offline.example.ts.net", online: false },
        candidate,
      ],
    });
  });

  test("deduplicates candidate IDs and bounds deterministic candidate ordering", () => {
    const candidateLimit = 1_000;
    const duplicateId = "n-duplicate";
    const sequentialIds = Array.from(
      { length: candidateLimit + 1 },
      (_, index) => `n-${String(index).padStart(4, "0")}`,
    );
    const peers = Object.fromEntries([
      ["duplicate-first", { ID: duplicateId, DNSName: "duplicate-first.example.ts.net.", Online: true }],
      ["duplicate-second", { ID: duplicateId, DNSName: "duplicate-second.example.ts.net.", Online: false }],
      ...sequentialIds.map((id) => [
        `peer-${id}`,
        { ID: id, DNSName: `peer-${id}.example.ts.net.`, Online: true },
      ]),
    ]);

    const enumeration = enumerateTailnetCandidates({
      Self: { ID: "n-local", DNSName: "local.example.ts.net." },
      Peer: peers,
    });

    expect(enumeration.kind).toBe("valid");
    if (enumeration.kind !== "valid") throw new Error("expected valid local Tailnet status");
    expect(enumeration.candidates).toHaveLength(candidateLimit);
    expect(enumeration.candidates.filter((candidate) => candidate.tailnetNodeId === duplicateId)).toEqual([{
      hostname: "duplicate-first.example.ts.net",
      tailnetNodeId: duplicateId,
      origin: "https://duplicate-first.example.ts.net",
      online: true,
    }]);
    expect(enumeration.candidates.map((candidate) => candidate.tailnetNodeId)).toEqual([
      ...sequentialIds.slice(0, candidateLimit - 1),
      duplicateId,
    ].sort((left, right) => left.localeCompare(right)));
    expect(enumeration.candidates.map((candidate) => candidate.tailnetNodeId)).not.toContain(sequentialIds[candidateLimit - 1]);
    expect(enumeration.candidates.map((candidate) => candidate.tailnetNodeId)).not.toContain(sequentialIds[candidateLimit]);
  });
});
