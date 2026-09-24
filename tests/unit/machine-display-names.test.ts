import { describe, expect, test } from "bun:test";
import { MachineDisplayNames } from "../../public/machine-display-names";

const installation = "2af8af29-c4fe-44f9-8a99-2a0e35952d74";
const identity = `n-peer:${installation}`;
const info = { machineId: installation, name: "peer-MacBook-Pro" };
const current = () => true;

describe("machine display names are optional identity-bound metadata", () => {
  test("retains the full host name and caches it for five minutes", async () => {
    let now = 0, calls = 0;
    const names = new MachineDisplayNames(() => now);
    const read = async () => { calls++; return info; };
    expect(await names.resolve(identity, read, current)).toBe(info.name);
    now = 299_999;
    expect(await names.resolve(identity, read, current)).toBe(info.name);
    expect(calls).toBe(1);
    now++;
    expect(await names.resolve(identity, async () => ({ ...info, name: "renamed-MacBook" }), current)).toBe("renamed-MacBook");
  });

  test("rejects mismatched installations, malformed or unbounded labels", async () => {
    for (const value of [null, {}, { ...info, machineId: "other" }, { ...info, name: 4 }, { ...info, name: " " }, { ...info, name: "x".repeat(256) }, { ...info, name: "bad\nname" }]) {
      const names = new MachineDisplayNames();
      expect(await names.resolve(identity, async () => value, current)).toBeUndefined();
      expect(names.get(identity)).toBeUndefined();
    }
  });

  test("does not turn URLs or names into machine identity", async () => {
    let calls = 0;
    const names = new MachineDisplayNames();
    for (const key of ["peer", "https://peer.example.ts.net", ""]) expect(await names.resolve(key, async () => { calls++; return info; }, current)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("caches unavailable metadata without failing sessions", async () => {
    let calls = 0;
    const names = new MachineDisplayNames();
    const read = async () => { calls++; throw Error("timeout"); };
    expect(await names.resolve(identity, read, current)).toBeUndefined();
    expect(await names.resolve(identity, read, current)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("does not cache a stale or cancelled refresh", async () => {
    const names = new MachineDisplayNames();
    expect(await names.resolve(identity, async () => info, () => false)).toBeUndefined();
    expect(names.get(identity)).toBeUndefined();
    expect(await names.resolve(identity, async () => info, current)).toBe(info.name);
  });

  test("a replacement installation cannot inherit the previous name", async () => {
    const names = new MachineDisplayNames();
    await names.resolve(identity, async () => info, current);
    const replacement = "n-peer:2af8af29-c4fe-44f9-8a99-2a0e35952d75";
    expect(await names.resolve(replacement, async () => info, current)).toBeUndefined();
  });

  test("bounds the display cache independently of routing state", async () => {
    const names = new MachineDisplayNames();
    for (let i = 0; i < 129; i++) await names.resolve(`n-${i}:${installation}`, async () => info, current);
    expect(names.get(`n-0:${installation}`)).toBeUndefined();
    expect(names.get(`n-128:${installation}`)).toBe(info.name);
  });
});
