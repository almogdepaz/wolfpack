import { describe, expect, test } from "bun:test";
import { classifyTailnetPeerHandshake } from "../../src/tailnet-peer-discovery.js";

const candidate = {
  hostname: "work-mac.example.ts.net",
  nodeId: "n123",
  url: "https://work-mac.example.ts.net",
};

const readyHandshake = {
  protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
  machine: {
    tailnetNodeId: "n123",
    installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
    displayName: "work-mac",
    url: candidate.url,
  },
  wolfpack: { version: "1.6.11" },
  capabilities: ["sessions", "terminal-websocket", "push-subscription"],
};

describe("classifyTailnetPeerHandshake", () => {
  test("accepts only a matching supported machine handshake", () => {
    expect(classifyTailnetPeerHandshake(candidate, { status: 200, body: readyHandshake })).toEqual({
      status: "ready",
      ...candidate,
      name: "work-mac",
      version: "1.6.11",
      peerId: "n123:2af8af29-c4fe-44f9-9a99-9a0e35952d74",
    });
  });

  test("separates unavailable, non-Wolfpack, and incompatible peers", () => {
    expect(classifyTailnetPeerHandshake(candidate, { status: "unreachable" })).toEqual({
      status: "offline",
      ...candidate,
    });
    expect(classifyTailnetPeerHandshake(candidate, { status: 404, body: {} })).toEqual({
      status: "non-wolfpack",
      ...candidate,
    });
    expect(classifyTailnetPeerHandshake(candidate, {
      status: 200,
      body: { ...readyHandshake, machine: { ...readyHandshake.machine, tailnetNodeId: "n999" } },
    })).toEqual({ status: "incompatible", ...candidate });
  });
});
