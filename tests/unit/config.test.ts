import { describe, expect, test } from "bun:test";

// ── Config functions (not exported, replicated here) ──

// Mirrors cli.ts Config interface
interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

// Mirrors cli.ts remoteUrl()
function remoteUrl(config: Config): string | null {
  if (!config.tailscaleHostname) return null;
  return `https://${config.tailscaleHostname}`;
}

// Mirrors serve.ts isAllowedOrigin()
// Parameterized to avoid module-level side effects (file reads, process.argv).
function isAllowedOrigin(
  origin: string,
  allowedOrigins: Set<string>,
  tailnetSuffix: string,
): boolean {
  if (allowedOrigins.has(origin)) return true;
  if (tailnetSuffix) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" && url.hostname.endsWith("." + tailnetSuffix)) return true;
    } catch {}
  }
  return false;
}

// ── Tests ──

describe("remoteUrl", () => {
  const base: Config = { devDir: "/home/dev", port: 18790 };

  test("returns https URL when tailscaleHostname is set", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "box.tail1234.ts.net" }))
      .toBe("https://box.tail1234.ts.net");
  });

  test("returns null when tailscaleHostname is undefined", () => {
    expect(remoteUrl(base)).toBeNull();
  });

  test("returns null when tailscaleHostname is empty string", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "" })).toBeNull();
  });

  test("preserves hostname exactly (no trailing slash)", () => {
    const result = remoteUrl({ ...base, tailscaleHostname: "my-machine.tailnet.ts.net" });
    expect(result).toBe("https://my-machine.tailnet.ts.net");
    expect(result!.endsWith("/")).toBe(false);
  });

  test("handles hostname with port-like suffix", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "box.tail.ts.net" }))
      .toBe("https://box.tail.ts.net");
  });

  test("handles single-label hostname", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "localhost" }))
      .toBe("https://localhost");
  });
});

describe("isAllowedOrigin", () => {
  const PORT = 18790;
  const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ]);
  const tailnetSuffix = "tailnet-name.ts.net";

  describe("localhost origins", () => {
    test("allows http://localhost:<PORT>", () => {
      expect(isAllowedOrigin(`http://localhost:${PORT}`, allowedOrigins, tailnetSuffix)).toBe(true);
    });

    test("allows http://127.0.0.1:<PORT>", () => {
      expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, allowedOrigins, tailnetSuffix)).toBe(true);
    });

    test("rejects localhost on wrong port", () => {
      expect(isAllowedOrigin("http://localhost:9999", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects localhost without port", () => {
      expect(isAllowedOrigin("http://localhost", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects https://localhost (not in allowlist)", () => {
      expect(isAllowedOrigin(`https://localhost:${PORT}`, allowedOrigins, tailnetSuffix)).toBe(false);
    });
  });

  describe("tailnet origins", () => {
    test("allows https host on same tailnet", () => {
      expect(isAllowedOrigin("https://other-box.tailnet-name.ts.net", allowedOrigins, tailnetSuffix)).toBe(true);
    });

    test("allows https host with deeper subdomain on same tailnet", () => {
      expect(isAllowedOrigin("https://a.b.tailnet-name.ts.net", allowedOrigins, tailnetSuffix)).toBe(true);
    });

    test("rejects http (non-https) on tailnet", () => {
      expect(isAllowedOrigin("http://other-box.tailnet-name.ts.net", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects different tailnet suffix", () => {
      expect(isAllowedOrigin("https://box.evil-tailnet.ts.net", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects suffix that's a substring but not a domain boundary", () => {
      // "faketailnet-name.ts.net" ends with "tailnet-name.ts.net" but
      // the code checks endsWith("." + suffix) so this should still match
      // because "faketailnet-name.ts.net".endsWith(".tailnet-name.ts.net") is false
      expect(isAllowedOrigin("https://faketailnet-name.ts.net", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects when tailnet suffix is empty", () => {
      expect(isAllowedOrigin("https://box.tailnet-name.ts.net", allowedOrigins, "")).toBe(false);
    });

    test("allows tailnet origin with port", () => {
      expect(isAllowedOrigin("https://box.tailnet-name.ts.net:443", allowedOrigins, tailnetSuffix)).toBe(true);
    });
  });

  describe("rejected origins", () => {
    test("rejects random external origin", () => {
      expect(isAllowedOrigin("https://evil.com", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isAllowedOrigin("", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects garbage / non-URL", () => {
      expect(isAllowedOrigin("not-a-url", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects null-origin style string", () => {
      expect(isAllowedOrigin("null", allowedOrigins, tailnetSuffix)).toBe(false);
    });

    test("rejects file:// origin", () => {
      expect(isAllowedOrigin("file:///etc/passwd", allowedOrigins, tailnetSuffix)).toBe(false);
    });
  });
});
