import { describe, expect, test } from "bun:test";
import { loadConfigFromText, parseConfig } from "../../src/cli/config.ts";

describe("parseConfig", () => {
  test("accepts a valid config object", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
      pluginDirs: ["/Users/home/.wolfpack/plugins"],
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
      pluginDirs: ["/Users/home/.wolfpack/plugins"],
    });
  });

  test("trims devDir and tailscaleHostname", () => {
    expect(parseConfig({
      devDir: "  /Users/home/Dev  ",
      port: 18790,
      tailscaleHostname: "  box.tail123.ts.net  ",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
    });
  });

  test("accepts numeric string ports from malformed JSON", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: "18790",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
    });
  });

  test("strips unknown fields like legacy 'backend'", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      backend: "broker",  // ignored — not part of Config any longer
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
    });
  });

  test("rejects malformed pluginDirs", () => {
    expect(parseConfig({ devDir: "/Users/home/Dev", port: 18790, pluginDirs: "../plugins" })).toBeNull();
    expect(parseConfig({ devDir: "/Users/home/Dev", port: 18790, pluginDirs: ["/tmp/plugins", 1] })).toBeNull();
  });

  test("returns null for missing devDir", () => {
    expect(parseConfig({ port: 18790 })).toBeNull();
  });

  test("returns null for empty devDir", () => {
    expect(parseConfig({ devDir: "   ", port: 18790 })).toBeNull();
  });

  test("returns null for invalid port", () => {
    expect(parseConfig({ devDir: "/Users/home/Dev", port: "nope" })).toBeNull();
    expect(parseConfig({ devDir: "/Users/home/Dev", port: 0 })).toBeNull();
    expect(parseConfig({ devDir: "/Users/home/Dev", port: 70000 })).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(parseConfig(null)).toBeNull();
    expect(parseConfig([])).toBeNull();
    expect(parseConfig("not json")).toBeNull();
  });
});

describe("loadConfigFromText", () => {
  test("loads valid JSON text", () => {
    expect(loadConfigFromText(JSON.stringify({
      devDir: "/Users/home/Dev",
      port: 18790,
    }))).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
    });
  });

  test("returns null for malformed JSON", () => {
    expect(loadConfigFromText("{not-json")).toBeNull();
  });

  test("returns null for invalid config shape", () => {
    expect(loadConfigFromText(JSON.stringify({ devDir: "/Users/home/Dev" }))).toBeNull();
  });
});
