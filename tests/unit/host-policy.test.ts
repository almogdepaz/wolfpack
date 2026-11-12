import { describe, expect, test } from "bun:test";
import { createHostPolicy, parseHostHeader } from "../../src/server/host-policy.js";

const selfStatus = {
  Self: {
    DNSName: "workstation.tailnet.ts.net.",
    HostName: "Workstation",
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  },
};

function policyWithStatus(readSelfStatus: () => Promise<unknown> = async () => selfStatus) {
  return createHostPolicy({ configuredHostname: undefined, extraHosts: [], readSelfStatus });
}

describe("parseHostHeader", () => {
  test.each([
    ["localhost:18790", "localhost"],
    ["WorkStation.tailnet.ts.net.:443", "workstation.tailnet.ts.net"],
    ["127.0.0.1:0", "127.0.0.1"],
    ["[::1]:65535", "::1"],
    ["[::ffff:127.0.0.1]", "::ffff:7f00:1"],
    ["[FD7A:115C:A1E0:0:0:0:0:1]:443", "fd7a:115c:a1e0::1"],
  ])("normalizes %s", (input, expected) => {
    expect(parseHostHeader(input)).toBe(expected);
  });

  test.each([
    "", " localhost", "localhost ", "local\nhost", "localhost\u0000", "localhost\u007f",
    "[::1", "::1", "[::1]extra", "[::1]:", "[::1]:-1", "[::1]:65536", "[127.0.0.1]",
    "localhost:", "localhost:abc", "localhost:65536", "localhost:1:2", "localhost,evil.example",
    "http://localhost", "localhost/path", "localhost?query", "localhost#fragment", "user@localhost",
    "local\\host", "localhost..", "foo..bar", "-host", "host-", "*.example", "%6cocalhost",
    `${"x".repeat(64)}.example`, `${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}`,
    "[fe80::1%lo0]", "localhost\n", "[::1]\n", "localhost:80\r\n",
  ])("rejects malformed %s", input => {
    expect(parseHostHeader(input)).toBeNull();
  });
});

describe("Host allowlist policy", () => {
  test.each([
    "localhost:18790", "127.0.0.1:18790", "[::1]:18790", "[0:0:0:0:0:0:0:1]",
    "WorkStation.tailnet.ts.net.", "workstation", "100.64.0.1",
    "[fd7a:115c:a1e0::1]:443", "[FD7A:115C:A1E0:0:0:0:0:1]",
  ])("allows the local host %s", async host => {
    expect(await policyWithStatus().isAllowed(host)).toBe(true);
  });

  test.each([
    undefined, "", "evil.example", "workstation.evil.example", "evil-workstation.tailnet.ts.net",
    "100.64.0.2", "127.0.0.2", "[::1", "[fd7a:115c:a1e0::2]",
  ])("rejects foreign or malformed Host %s", async host => {
    expect(await policyWithStatus().isAllowed(host)).toBe(false);
  });

  test("allows configured names and extra hosts when discovery fails", async () => {
    const policy = createHostPolicy({
      configuredHostname: "configured.tailnet.ts.net",
      extraHosts: ["proxy.example", "2001:db8::1"],
      readSelfStatus: async () => { throw new Error("tailscale unavailable"); },
    });
    for (const host of ["localhost", "configured", "configured.tailnet.ts.net", "proxy.example:443", "[2001:db8::1]"]) {
      expect(await policy.isAllowed(host)).toBe(true);
    }
    expect(await policy.isAllowed("proxy")).toBe(false);
    expect(await policy.isAllowed("foreign.example")).toBe(false);
  });

  test("does not refresh for foreign DNS names, non-Tailscale IPs, or malformed hosts", async () => {
    let reads = 0;
    const policy = policyWithStatus(async () => { reads++; return selfStatus; });
    for (const host of ["evil.example", "workstation.evil.example", "evil.ts.net.example", "127.0.0.2", "100.63.255.255", "100.128.0.1", "[fd7a:115c:a1e1::1]", "[::1", undefined]) {
      expect(await policy.isAllowed(host)).toBe(false);
    }
    expect(reads).toBe(1);
  });

  test.each(["100.127.255.255", "[fd7a:115c:a1e0::2]"])("admits a new self IP after one refresh: %s", async host => {
    let reads = 0;
    const policy = policyWithStatus(async () => ++reads === 1 ? selfStatus : {
      Self: { ...selfStatus.Self, TailscaleIPs: ["100.127.255.255", "fd7a:115c:a1e0::2"] },
    });
    expect(await policy.isAllowed(host)).toBe(true);
    expect(reads).toBe(2);
  });

  test.each(["renamed", "renamed.tailnet.ts.net"])("admits renamed MagicDNS host %s listed by the second read", async host => {
    let reads = 0;
    const policy = policyWithStatus(async () => ++reads === 1 ? selfStatus : {
      Self: { ...selfStatus.Self, DNSName: "renamed.tailnet.ts.net." },
    });
    expect(await policy.isAllowed(host)).toBe(true);
    expect(reads).toBe(2);
  });

  test.each(["unknown", "unknown.other.ts.net", "100.64.0.2", "[fd7a:115c:a1e0::2]"])("refreshes once without authorizing a non-self host %s", async host => {
    let reads = 0;
    const policy = policyWithStatus(async () => { reads++; return selfStatus; });
    expect(await policy.isAllowed(host)).toBe(false);
    expect(reads).toBe(2);
  });

  test("recovers after discovery initially fails without accepting peer identities", async () => {
    let reads = 0;
    const policy = policyWithStatus(async () => {
      if (++reads === 1) throw new Error("tailscale unavailable");
      return { ...selfStatus, Peer: { peer: { DNSName: "peer.tailnet.ts.net.", TailscaleIPs: ["100.64.0.2"] } } };
    });
    expect(await policy.isAllowed("workstation")).toBe(true);
    expect(await policy.isAllowed("peer.tailnet.ts.net")).toBe(false);
    expect(await policy.isAllowed("100.64.0.2")).toBe(false);
  });

  test.each([null, {}, { Self: [] }, { Self: { DNSName: 42, TailscaleIPs: [null, "evil.example", 42] } }])("ignores malformed self status %j", async status => {
    const policy = policyWithStatus(async () => status);
    expect(await policy.isAllowed("localhost")).toBe(true);
    expect(await policy.isAllowed("evil.example")).toBe(false);
    expect(await policy.isAllowed("workstation")).toBe(false);
  });
});
