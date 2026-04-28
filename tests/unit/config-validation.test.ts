import { describe, expect, test } from "bun:test";
import { loadConfigFromText, parseConfig } from "../../src/cli/config.ts";

describe("parseConfig", () => {
  test("accepts a valid config object", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
      backend: undefined,
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
      backend: undefined,
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
      backend: undefined,
    });
  });

  test("accepts backend 'pty'", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      backend: "pty",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
      backend: "pty",
    });
  });

  test("accepts backend 'broker'", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      backend: "broker",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
      backend: "broker",
    });
  });

  test("ignores invalid backend values", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      backend: "invalid",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: undefined,
      backend: undefined,
    });
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
      backend: undefined,
    });
  });

  test("returns null for malformed JSON", () => {
    expect(loadConfigFromText("{not-json")).toBeNull();
  });

  test("returns null for invalid config shape", () => {
    expect(loadConfigFromText(JSON.stringify({ devDir: "/Users/home/Dev" }))).toBeNull();
  });
});
