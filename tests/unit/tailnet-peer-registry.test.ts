import { describe, expect, test } from "bun:test";
import {
  TailnetPeerRegistry,
  probeTailnetCandidates,
  stableMachineIdentity,
} from "../../src/tailnet-peer-registry.ts";
import { MACHINE_CAPABILITY } from "../../src/tailnet-machine-contract.ts";
import type { MachineHandshake, TailnetMachineCandidate } from "../../src/tailnet-machine-contract.ts";

const installationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
const MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT = 32 * 1024;
const candidate = {
  hostname: "peer.example.ts.net",
  tailnetNodeId: "n-peer",
  origin: "https://peer.example.ts.net",
  online: true,
} as const;

function stalledCandidates(count: number): TailnetMachineCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const hostname = `stalled-${suffix}.example.ts.net`;
    return {
      hostname,
      tailnetNodeId: `n-stalled-${suffix}`,
      origin: `https://${hostname}`,
      online: true,
    };
  });
}

function handshake(
  origin: string = candidate.origin,
  displayName = "peer",
  handshakeInstallationId = installationId,
): MachineHandshake {
  return {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: candidate.tailnetNodeId, installationId: handshakeInstallationId, displayName, origin },
    wolfpack: { version: "1.7.0" },
    capabilities: [
      MACHINE_CAPABILITY.SESSIONS,
      MACHINE_CAPABILITY.TERMINAL_WEBSOCKET,
      MACHINE_CAPABILITY.PUSH_SUBSCRIPTION,
    ],
  };
}

describe("browser tailnet peer registry", () => {
  test("probes only candidate machine endpoints with redirect and credentials disabled", async () => {
    const calls: Array<{ readonly input: string; readonly init: RequestInit }> = [];
    const outcomes = await probeTailnetCandidates([candidate, {
      ...candidate,
      hostname: "offline.example.ts.net",
      tailnetNodeId: "n-offline",
      origin: "https://offline.example.ts.net",
      online: false,
    }], async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(handshake()), { status: 200 });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "https://peer.example.ts.net/api/machine",
      init: { redirect: "error", credentials: "omit" },
    });
    expect(outcomes.map(outcome => outcome.status)).toEqual(["ready", "offline"]);
  });

  test("bounds each probe and lets a healthy peer finish while another stalls", async () => {
    const healthy = { ...candidate, tailnetNodeId: "n-healthy", hostname: "healthy.example.ts.net", origin: "https://healthy.example.ts.net" };
    const started = Date.now();
    const outcomes = await probeTailnetCandidates([candidate, healthy], async (input) => {
      if (input.includes("peer.example")) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({
        ...handshake(healthy.origin, "healthy"),
        machine: { tailnetNodeId: healthy.tailnetNodeId, installationId, displayName: "healthy", origin: healthy.origin },
      }));
    }, { timeoutMs: 20, maxConcurrent: 2 });

    expect(Date.now() - started).toBeLessThan(500);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["offline", "ready"]);
  });

  test("rejects an oversized declared handshake response without consuming its body", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), { headers: { "content-length": String(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT + 1) } });

    let fetchSignal: AbortSignal | null | undefined;
    const outcomes = await probeTailnetCandidates([candidate], async (_input, init) => {
      fetchSignal = init.signal;
      return response;
    });

    expect(outcomes).toEqual([expect.objectContaining({
      status: "malformed",
      diagnostic: "machine handshake response exceeds 32 KiB",
    })]);
    expect(fetchSignal?.aborted).toBe(true);
    expect(response.bodyUsed).toBe(false);
  });

  test.each([
    ["chunked", undefined],
    ["understated", "1"],
  ])("rejects and cancels an oversized %s handshake stream", async (_kind, contentLength) => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT + 1));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      headers: contentLength === undefined ? undefined : { "content-length": contentLength },
    });

    const outcomes = await probeTailnetCandidates([candidate], async () => response);

    expect(outcomes).toEqual([expect.objectContaining({
      status: "malformed",
      diagnostic: "machine handshake response exceeds 32 KiB",
    })]);
    expect(cancelled).toBe(true);
  });

  test("settles an oversized handshake when stream cancellation never resolves", async () => {
    const timeoutMs = 20;
    const stalled = Symbol("stalled");
    let fetchSignal: AbortSignal | null | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT + 1));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    }));
    const batch = probeTailnetCandidates([candidate], async (_input, init) => {
      fetchSignal = init.signal;
      return response;
    }, { timeoutMs });

    const outcomes = await Promise.race([
      batch,
      new Promise<typeof stalled>((resolve) => setTimeout(() => resolve(stalled), timeoutMs * 5)),
    ]);

    expect(outcomes).not.toBe(stalled);
    if (outcomes === stalled) throw new Error("oversized handshake probe did not settle");
    expect(outcomes).toEqual([expect.objectContaining({
      status: "malformed",
      diagnostic: "machine handshake response exceeds 32 KiB",
    })]);
    expect(fetchSignal?.aborted).toBe(true);
  });

  test("accepts a valid handshake response at the byte ceiling", async () => {
    const encoder = new TextEncoder();
    const payloadWithEmptyPadding = JSON.stringify({ ...handshake(), padding: "" });
    const payload = JSON.stringify({
      ...handshake(),
      padding: "x".repeat(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT - encoder.encode(payloadWithEmptyPadding).byteLength),
    });
    expect(encoder.encode(payload)).toHaveLength(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT);

    const outcomes = await probeTailnetCandidates([candidate], async () => new Response(payload, {
      headers: { "content-length": String(MACHINE_HANDSHAKE_RESPONSE_BYTE_LIMIT) },
    }));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["ready"]);
  });

  test("times out when a handshake body stalls after headers", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const timeoutMs = 20;
    const stalled = Symbol("stalled");
    const batch = probeTailnetCandidates([candidate], async (_input, init) => {
      init.signal?.addEventListener("abort", () => bodyController?.error(new Error("aborted")), { once: true });
      return new Response(body);
    }, { timeoutMs });

    try {
      const outcomes = await Promise.race([
        batch,
        new Promise<typeof stalled>((resolve) => setTimeout(() => resolve(stalled), timeoutMs * 5)),
      ]);
      expect(outcomes).not.toBe(stalled);
      if (outcomes === stalled) throw new Error("handshake body probe did not time out");
      expect(outcomes).toEqual([expect.objectContaining({
        status: "offline",
        diagnostic: "machine handshake did not respond",
      })]);
    } finally {
      bodyController?.error(new Error("test cleanup"));
      await batch;
    }
  });

  test("starts exactly eight default-concurrency probes", async () => {
    let started = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWave = new Promise<Response>((resolve) => {
      releaseFirstWave = () => resolve(new Response("", { status: 503 }));
    });
    const batch = probeTailnetCandidates(stalledCandidates(9), async () => {
      started++;
      return firstWave;
    });

    try {
      expect(started).toBe(8);
    } finally {
      releaseFirstWave?.();
    }
    await batch;
  });

  test("finishes 32 stalled peers in four short default-concurrency timeout waves", async () => {
    const timeoutMs = 25;
    let active = 0;
    let maxActive = 0;
    const started = Date.now();
    const outcomes = await probeTailnetCandidates(stalledCandidates(32), async (_input, init) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          active--;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }, { timeoutMs });
    const elapsed = Date.now() - started;

    expect(maxActive).toBe(8);
    expect(outcomes).toHaveLength(32);
    expect(outcomes.every((outcome) => outcome.status === "offline")).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs * 3);
    expect(elapsed).toBeLessThan(timeoutMs * 6);
  });

  test("reports a healthy settled probe before a stalled batch peer times out", async () => {
    const healthy = {
      ...candidate,
      hostname: "healthy.example.ts.net",
      tailnetNodeId: "n-healthy",
      origin: "https://healthy.example.ts.net",
    };
    let batchCompleted = false;
    let reportHealthy: (() => void) | undefined;
    const healthyReported = new Promise<void>((resolve) => {
      reportHealthy = resolve;
    });
    const batch = probeTailnetCandidates([candidate, healthy], async (input) => {
      if (input === `${candidate.origin}/api/machine`) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({
        ...handshake(healthy.origin, "healthy"),
        machine: {
          tailnetNodeId: healthy.tailnetNodeId,
          installationId,
          displayName: "healthy",
          origin: healthy.origin,
        },
      }));
    }, {
      timeoutMs: 50,
      maxConcurrent: 2,
      onSettled: (probe) => {
        if (probe.candidate.tailnetNodeId === healthy.tailnetNodeId && probe.status === "ready") {
          reportHealthy?.();
        }
      },
    }).finally(() => {
      batchCompleted = true;
    });

    await Promise.race([
      healthyReported,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("healthy probe was not reported promptly")), 20)),
    ]);
    expect(batchCompleted).toBe(false);
    await batch;
  });

  test.each([
    ["synchronous throw", () => { throw new Error("synchronous observer failure"); }],
    ["rejected Promise", () => Promise.reject(new Error("asynchronous observer failure"))],
  ])("contains an onSettled observer %s without blocking probe completion", async (_kind, onSettled) => {
    const uncaughtErrors: unknown[] = [];
    const unhandledRejections: unknown[] = [];
    const originalConsoleError = console.error;
    const diagnostic = new Promise<readonly unknown[]>((resolve) => {
      console.error = (...args: unknown[]): void => {
        console.error = originalConsoleError;
        resolve(args);
      };
    });
    const onUncaughtException = (error: unknown): void => { uncaughtErrors.push(error); };
    const onUnhandledRejection = (error: unknown): void => { unhandledRejections.push(error); };
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const outcomes = await probeTailnetCandidates([candidate], async () => (
        new Response(JSON.stringify(handshake()), { status: 200 })
      ), { onSettled });
      const reported = await Promise.race([
        diagnostic,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("observer failure was not reported")), 50)),
      ]);

      expect(outcomes.map(outcome => outcome.status)).toEqual(["ready"]);
      expect(uncaughtErrors).toEqual([]);
      expect(unhandledRejections).toEqual([]);
      expect(reported).toEqual([
        "tailnet probe settlement observer failed",
        expect.any(Error),
      ]);
    } finally {
      console.error = originalConsoleError;
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("reports a verified installation replacement while revoking the old stable identity", () => {
    const registry = new TailnetPeerRegistry();
    const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
    const oldIdentity = stableMachineIdentity(candidate.tailnetNodeId, installationId);
    const newIdentity = stableMachineIdentity(candidate.tailnetNodeId, replacementInstallationId);
    registry.applyProbe({ candidate, status: "ready", handshake: handshake() });

    const result = registry.applyProbe({
      candidate,
      status: "ready",
      handshake: handshake(candidate.origin, "replacement", replacementInstallationId),
    });

    expect(result).toEqual({
      kind: "identity-replaced",
      replacement: {
        tailnetNodeId: candidate.tailnetNodeId,
        oldIdentity,
        newIdentity,
      },
    });
    expect(registry.entries()).toEqual([expect.objectContaining({
      identity: newIdentity,
      displayName: "replacement",
      status: "ready",
    })]);
    expect(registry.resolveReadyOrigin(oldIdentity)).toBeUndefined();
    expect(registry.resolveReadyOrigin(newIdentity)).toBe(candidate.origin);
  });

  test("keeps one stable peer through hostname changes and recovery", () => {
    const registry = new TailnetPeerRegistry();
    const id = stableMachineIdentity(candidate.tailnetNodeId, installationId);
    registry.applyProbe({ candidate, status: "ready", handshake: handshake() });

    const renamed = {
      ...candidate,
      hostname: "renamed.example.ts.net",
      origin: "https://renamed.example.ts.net",
    };
    registry.applyProbe({ candidate: renamed, status: "ready", handshake: handshake(renamed.origin, "renamed") });

    expect(registry.entries()).toEqual([expect.objectContaining({
      identity: id,
      status: "ready",
      origin: renamed.origin,
      displayName: "renamed",
    })]);
    expect(registry.resolveReadyOrigin(id)).toBe(renamed.origin);
    registry.reconcileCandidates([]);
    expect(registry.entries()).toEqual([expect.objectContaining({
      identity: id,
      status: "offline",
      diagnostic: "candidate is no longer present in local Tailnet status",
    })]);
    expect(registry.resolveReadyOrigin(id)).toBeUndefined();
  });

  test("revokes ready origins when candidate enumeration is unavailable while retaining stale stable metadata", () => {
    const registry = new TailnetPeerRegistry();
    const id = stableMachineIdentity(candidate.tailnetNodeId, installationId);
    registry.applyProbe({ candidate, status: "ready", handshake: handshake() });

    registry.markCandidateEnumerationUnavailable();

    expect(registry.entries()).toEqual([expect.objectContaining({
      identity: id,
      status: "unavailable",
      origin: candidate.origin,
      hostname: candidate.hostname,
      displayName: "peer",
      diagnostic: "tailnet candidate enumeration unavailable",
    })]);
    expect(registry.resolveReadyOrigin(id)).toBeUndefined();

    registry.applyProbe({ candidate, status: "ready", handshake: handshake() });
    expect(registry.entries()).toEqual([expect.objectContaining({
      identity: id,
      status: "ready",
      origin: candidate.origin,
    })]);
    expect(registry.resolveReadyOrigin(id)).toBe(candidate.origin);
  });

  test("keeps first-seen failed candidates transient and never routes legacy URLs", () => {
    const registry = new TailnetPeerRegistry();
    registry.applyProbe({ candidate, status: "malformed", diagnostic: "invalid handshake response" });
    registry.applyLegacyDisplayMetadata([
      { url: "https://evil.example", name: "evil" },
      { url: candidate.origin, name: "old peer label" },
    ]);

    expect(registry.entries()).toEqual([expect.objectContaining({
      tailnetNodeId: candidate.tailnetNodeId,
      status: "malformed",
      displayName: "old peer label",
      identity: undefined,
    })]);
    expect(registry.resolveReadyOrigin(stableMachineIdentity(candidate.tailnetNodeId, installationId))).toBeUndefined();
  });
});
