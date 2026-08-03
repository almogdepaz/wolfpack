import { describe, expect, test } from "bun:test";
import { buildTailnetMachineHandshake } from "../../src/tailnet-machine-contract.js";

describe("buildTailnetMachineHandshake", () => {
  test("advertises only a complete verified Tailnet machine identity", () => {
    expect(buildTailnetMachineHandshake({
      tailscaleHostname: "work-mac.example.ts.net",
      tailscaleNodeId: "n123",
      installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
      displayName: "work-mac",
      version: "1.6.11",
    })).toEqual({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n123",
        installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
        displayName: "work-mac",
        url: "https://work-mac.example.ts.net",
      },
      wolfpack: { version: "1.6.11" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    });
  });

  test("does not advertise a partial or malformed remote identity", () => {
    const complete = {
      tailscaleHostname: "work-mac.example.ts.net",
      tailscaleNodeId: "n123",
      installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
      displayName: "work-mac",
      version: "1.6.11",
    };

    expect(buildTailnetMachineHandshake({ ...complete, tailscaleNodeId: undefined })).toBeNull();
    expect(buildTailnetMachineHandshake({ ...complete, installationId: "not-a-uuid" })).toBeNull();
    expect(buildTailnetMachineHandshake({ ...complete, tailscaleHostname: "http://evil.example" })).toBeNull();
  });
});
