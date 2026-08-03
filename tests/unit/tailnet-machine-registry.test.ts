import { describe, expect, test } from "bun:test";
import {
  mergeDiscoveredTailnetMachines,
  parseStoredMachines,
} from "../../public/tailnet-machine-registry.js";

describe("Tailnet machine registry", () => {
  test("updates a discovered machine after its hostname changes without losing its identity", () => {
    const result = mergeDiscoveredTailnetMachines([
      { url: "https://old-name.example.ts.net", name: "old-name", peerId: "n123:2af8af29-c4fe-44f9-9a99-9a0e35952d74" },
      { url: "http://localhost:18790", name: "local dev", peerId: undefined },
    ], [{
      url: "https://new-name.example.ts.net",
      name: "new-name",
      peerId: "n123:2af8af29-c4fe-44f9-9a99-9a0e35952d74",
    }]);

    expect(result).toEqual([
      { url: "https://new-name.example.ts.net", name: "new-name", peerId: "n123:2af8af29-c4fe-44f9-9a99-9a0e35952d74" },
      { url: "http://localhost:18790", name: "local dev", peerId: undefined },
    ]);
  });

  test("drops stale discovered machines but retains manual entries", () => {
    const result = mergeDiscoveredTailnetMachines([
      { url: "https://offline.example.ts.net", name: "offline", peerId: "n456:2af8af29-c4fe-44f9-9a99-9a0e35952d74" },
      { url: "http://localhost:18790", name: "local dev", peerId: undefined },
    ], []);

    expect(result).toEqual([{ url: "http://localhost:18790", name: "local dev", peerId: undefined }]);
  });

  test("does not trust malformed persisted peer ids", () => {
    expect(parseStoredMachines([{ url: "https://work.example.ts.net", name: "work", peerId: "javascript:alert(1)" }]))
      .toEqual([{ url: "https://work.example.ts.net", name: "work", peerId: undefined }]);
  });
});
