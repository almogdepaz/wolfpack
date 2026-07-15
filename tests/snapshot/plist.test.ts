import { describe, expect, test } from "bun:test";
import { renderPlist, renderBrokerPlist } from "../../src/cli/service.ts";

const DEFAULT_CONFIG = { devDir: "/Users/home/Dev", port: 18790 };
const DEFAULT_ARGS = ["/opt/homebrew/bin/bun", "/Users/home/Dev/wolfpack/cli.ts"];
const DEFAULT_LOG = "/Users/home/.wolfpack/wolfpack.log";
const SERVICE_AUTH = "/Users/home/.wolfpack/service-auth.json";

describe("renderPlist", () => {
  test("includes service env vars, args, and log paths", () => {
    const plist = renderPlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
    expect(plist).toContain("<string>com.wolfpack.server</string>");
    expect(plist).toContain("<key>WOLFPACK_SERVICE</key>");
    expect(plist).toContain("<key>WOLFPACK_DEV_DIR</key>");
    expect(plist).toContain("<key>WOLFPACK_PORT</key>");
    expect(plist).toContain(`<string>${DEFAULT_LOG}</string>`);
    for (const arg of DEFAULT_ARGS) {
      expect(plist).toContain(`<string>${arg}</string>`);
    }
  });

  test("keeps WOLFPACK_SERVICE even without config", () => {
    const plist = renderPlist(null, DEFAULT_ARGS, DEFAULT_LOG);
    expect(plist).toContain("<key>WOLFPACK_SERVICE</key>");
    expect(plist).not.toContain("WOLFPACK_DEV_DIR");
    expect(plist).not.toContain("WOLFPACK_PORT");
  });

  test("references private service credentials without embedding the JWT secret", () => {
    const plist = renderPlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG, SERVICE_AUTH);
    expect(plist).toContain("<key>WOLFPACK_SERVICE_AUTH_FILE</key>");
    expect(plist).toContain(`<string>${SERVICE_AUTH}</string>`);
    expect(plist).not.toContain("WOLFPACK_JWT_SECRET");
  });

  test("supports compiled binary execution", () => {
    const plist = renderPlist(DEFAULT_CONFIG, ["/usr/local/bin/wolfpack"], DEFAULT_LOG);
    expect(plist).toContain("<string>/usr/local/bin/wolfpack</string>");
  });

  test("escapes XML-sensitive values", () => {
    const plist = renderPlist(
      { devDir: '/Users/home/Dev & "Projects"', port: 18790 },
      DEFAULT_ARGS,
      '/Users/home/.wolfpack/log & "trace".txt',
    );
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&quot;");
  });
});

describe("renderBrokerPlist", () => {
  const BIN = "/Users/home/.wolfpack/bin/wolfpack-broker";
  const LOG = "/Users/home/.wolfpack/broker.log";

  test("uses broker label and includes binary + log paths", () => {
    const plist = renderBrokerPlist(BIN, LOG);
    expect(plist).toContain("<string>com.wolfpack.broker</string>");
    expect(plist).toContain(`<string>${BIN}</string>`);
    expect(plist).toContain(`<string>${LOG}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
  });

  test("escapes XML-sensitive values", () => {
    const plist = renderBrokerPlist('/dir & "weird"/wolfpack-broker', LOG);
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&quot;");
  });
});
