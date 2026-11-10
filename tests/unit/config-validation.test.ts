import { describe, expect, test } from "bun:test";
import { loadConfigFromText, parseConfig } from "../../src/cli/config.ts";

describe("parseConfig", () => {
  test("keeps the Claude task integration opt-in only when it is true", () => {
    const base = { devDir: "/Users/home/Dev", port: 18790 };
    expect(parseConfig({ ...base, claudeTaskIntegration: true })).toEqual({ ...base, claudeTaskIntegration: true });
    expect(parseConfig({ ...base, claudeTaskIntegration: false })).toEqual(base);
    expect(parseConfig({ ...base, claudeTaskIntegration: "yes" })).toEqual(base);
    expect(parseConfig(base)).toEqual(base);
  });

  test("keeps the child-event typed-note setting only when it turns notes off", () => {
    const base = { devDir: "/Users/home/Dev", port: 18790 };
    expect(parseConfig({ ...base, childEventTypedNotes: false })).toEqual({ ...base, childEventTypedNotes: false });
    expect(parseConfig({ ...base, childEventTypedNotes: true })).toEqual(base);
    expect(parseConfig({ ...base, childEventTypedNotes: "off" })).toEqual(base);
  });

  test("accepts a valid config object", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
    })).toEqual({
      devDir: "/Users/home/Dev",
      port: 18790,
      tailscaleHostname: "box.tail123.ts.net",
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

  test("clears malformed optional tailscale readiness without discarding local config", () => {
    expect(parseConfig({
      devDir: "/tmp/x",
      port: 8787,
      tailscaleHostname: "https://evil.example.com",
    })).toEqual({
      devDir: "/tmp/x",
      port: 8787,
      tailscaleHostname: undefined,
    });
  });

  test("keeps a trimmed host display-name override", () => {
    expect(parseConfig({
      devDir: "/Users/home/Dev",
      port: 18790,
      displayName: "  Studio Mac  ",
    })).toMatchObject({ displayName: "Studio Mac" });
  });

  test("clears an invalid display-name override without discarding local config", () => {
    for (const displayName of [42, "", "   ", "bad\nname", "x".repeat(129)]) {
      const config = parseConfig({ devDir: "/tmp/x", port: 8787, displayName });
      expect(config).toMatchObject({ devDir: "/tmp/x", port: 8787 });
      expect(config?.displayName).toBeUndefined();
    }
  });

  test("normalizes extra allowed hosts and drops invalid entries", () => {
    const base = { devDir: "/tmp/x", port: 18790 };
    const config = parseConfig({ ...base, allowedHosts: [
      "Proxy.Example.:443", "localhost:8080", "100.64.0.1", "[FD7A:115C:A1E0:0:0:0:0:1]:443",
      "https://evil.example", "host/path", "host:99999", "*.example", "bad\nhost", "", 42, null,
    ] });
    expect(config?.allowedHosts).toEqual(["proxy.example", "localhost", "100.64.0.1", "fd7a:115c:a1e0::1"]);
    expect(loadConfigFromText(JSON.stringify(config))).toEqual(config);
  });

  test("omits empty, invalid or non-array allowedHosts settings", () => {
    const base = { devDir: "/tmp/x", port: 18790 };
    for (const allowedHosts of [undefined, null, "proxy.example", {}, [], [42, "https://evil.example"]]) {
      const config = parseConfig({ ...base, allowedHosts });
      expect(config).toEqual(base);
      expect(config).not.toHaveProperty("allowedHosts");
    }
  });

  test("caps allowedHosts at 32 valid entries", () => {
    const hosts = Array.from({ length: 40 }, (_, index) => `proxy-${index}.example`);
    const config = parseConfig({ devDir: "/tmp/x", port: 18790, allowedHosts: [null, ...hosts] });
    expect(config?.allowedHosts).toEqual(hosts.slice(0, 32));
  });

  test("rejects non-number and fractional ports", () => {
    for (const port of ["18790", true, false, 18790.5, NaN, Infinity]) {
      expect(parseConfig({ devDir: "/Users/home/Dev", port })).toBeNull();
    }
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
