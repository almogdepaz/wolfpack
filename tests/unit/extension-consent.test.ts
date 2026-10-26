import { afterEach, describe, expect, test } from "bun:test";
import { SelectedHostExtensionTransport } from "../../public/extension-transport.ts";
import type { ExtensionReadyPeer } from "../../public/extension-transport.ts";
import type { ExtensionCatalogEnvelope, ExtensionCatalogInstallation } from "../../src/extensions/runtime-contract.ts";

const machine = "node-a:11111111-1111-4111-8111-111111111111";
const other = "node-b:33333333-3333-4333-8333-333333333333";
const origin = "https://peer.example.ts.net";
const storageKey = "wp-extension-code-consent:v1";
const item: ExtensionCatalogInstallation = {
  installationId: "11111111-1111-4111-8111-111111111111", extensionId: "notes", enabled: true,
  package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) },
  ui: { path: "dist/ui.js", url: "/api/extensions/assets/notes/" + "a".repeat(64) + "/dist/ui.js", digest: "b".repeat(64), mime: "text/javascript" }, documents: [],
};
const catalog = (installations: readonly ExtensionCatalogInstallation[] = [item]): ExtensionCatalogEnvelope => ({ safeMode: false, installations });
const scope = { sessionId: "22222222-2222-4222-8222-222222222222", machine };
const signal = () => new AbortController().signal;
const original = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, descriptor: PropertyDescriptor): void {
  if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, ...descriptor });
}
afterEach(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  original.clear();
});
function fixture() {
  const stored = new Map<string, string>();
  const faults = { read: false, write: false, remove: false };
  replace("localStorage", { value: {
    getItem: (key: string) => { if (faults.read) throw new Error("storage read denied"); return stored.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (faults.write) throw new Error("storage write denied"); stored.set(key, value); },
    removeItem: (key: string) => { if (faults.remove) throw new Error("storage remove denied"); stored.delete(key); },
  } });
  let peer: ExtensionReadyPeer | undefined = { identity: machine, status: "ready", origin, displayName: "Peer" };
  let prompts = 0, answer: Record<string, string> | null = {};
  const create = (resolvePeer = (_machine: string) => peer) => new SelectedHostExtensionTransport({ resolvePeer,
    prompt: async () => { prompts++; return answer; } });
  return { stored, faults, create, get prompts() { return prompts; }, set answer(value: Record<string, string> | null) { answer = value; },
    set peer(value: ExtensionReadyPeer | undefined) { peer = value; } };
}

describe("remote executable inventory consent", () => {
  test("a new transport remembers exactly the sorted approved inventory per stable identity", async () => {
    const f = fixture();
    const second = { ...item, extensionId: "other", package: { ...item.package, name: "other" } };
    const disabled = { ...item, extensionId: "disabled", enabled: false };
    const dataOnly = { ...item, extensionId: "data", ui: undefined };
    const offered = catalog([second, disabled, item, dataOnly]);
    const transport = f.create();
    expect(await transport.consentRemoteCode(scope, offered, signal())).toBe(true);
    expect(await transport.consentRemoteCode(scope, offered, signal())).toBe(true);
    expect(await f.create().consentRemoteCode(scope, catalog([dataOnly, item, disabled, second]), signal())).toBe(true);
    expect(f.prompts).toBe(1);
    expect(JSON.parse(f.stored.get(storageKey)!)).toEqual([[machine, `${origin}|${JSON.stringify([
      [item.installationId, item.extensionId, item.package.digest, item.ui!.path, item.ui!.digest],
      [second.installationId, second.extensionId, second.package.digest, second.ui!.path, second.ui!.digest],
    ])}`]]);
  });

  test.each(["installationId", "extensionId", "package digest", "UI path", "UI digest", "enabled inventory"])("changed %s requires fresh consent after reload", async field => {
    const f = fixture();
    await f.create().consentRemoteCode(scope, catalog(), signal());
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(1);
    const changed = field === "installationId" ? { ...item, installationId: "44444444-4444-4444-8444-444444444444" }
      : field === "extensionId" ? { ...item, extensionId: "replacement" }
      : field === "package digest" ? { ...item, package: { ...item.package, digest: "c".repeat(64) } }
      : field === "UI path" ? { ...item, ui: { ...item.ui!, path: "dist/new.js" } }
      : field === "UI digest" ? { ...item, ui: { ...item.ui!, digest: "c".repeat(64) } }
      : { ...item, enabled: false };
    await f.create().consentRemoteCode(scope, catalog([changed]), signal());
    expect(f.prompts).toBe(2);
  });

  test("origin and stable machine identity are separate trust boundaries", async () => {
    const f = fixture(); const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(1);
    f.peer = { identity: machine, status: "ready", origin: "https://moved.example.ts.net", displayName: "Peer" };
    await f.create().consentRemoteCode(scope, catalog(), signal());
    f.peer = { identity: other, status: "ready", origin: "https://moved.example.ts.net", displayName: "Peer" };
    await f.create().consentRemoteCode({ ...scope, machine: other }, catalog(), signal());
    expect(f.prompts).toBe(3);
  });

  test("declining changed inventory clears stale consent in memory and storage", async () => {
    const f = fixture(); const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    f.answer = null;
    expect(await transport.consentRemoteCode(scope, catalog([]), signal())).toBe(false);
    expect(f.stored.has(storageKey)).toBe(false);
    f.answer = {};
    await transport.consentRemoteCode(scope, catalog(), signal());
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(3);
  });

  test.each(["offline", "identity", "origin", "missing"])("%s peer invalidation clears both stores even through request", async failure => {
    const f = fixture(); const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.stored.has(storageKey)).toBe(true);
    f.peer = failure === "missing" ? undefined : { identity: failure === "identity" ? other : machine,
      status: failure === "offline" ? "offline" : "ready", origin: failure === "origin" ? "http://evil.test" : origin, displayName: "Peer" };
    await expect(transport.request(scope, "/api/extensions", {})).rejects.toThrow("unavailable");
    expect(f.stored.has(storageKey)).toBe(false);
    f.peer = { identity: machine, status: "ready", origin, displayName: "Peer" };
    await transport.consentRemoteCode(scope, catalog(), signal());
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(2);
  });

  test.each(["read", "write", "getter"])("%s storage denial falls back to same-instance memory, reload prompts", async failure => {
    const f = fixture();
    if (failure === "getter") replace("localStorage", { get: () => { throw new Error("storage unavailable"); } });
    else f.faults[failure] = true;
    const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(1);
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(2);
  });

  test("unwritable storage never silently restores an existing grant on reload", async () => {
    const f = fixture();
    await f.create().consentRemoteCode(scope, catalog(), signal());
    f.faults.write = true; f.faults.remove = true;
    const reload = f.create();
    await reload.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(2);
    await reload.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(2);
    await f.create().consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(3);
  });

  test("remove failures never crash or retain same-instance stale trust", async () => {
    const f = fixture(); const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.stored.has(storageKey)).toBe(true);
    f.faults.remove = true; f.answer = null;
    expect(await transport.consentRemoteCode(scope, catalog([]), signal())).toBe(false);
    expect(JSON.parse(f.stored.get(storageKey)!)).toEqual([]); // writable fallback tombstone
    f.answer = {};
    await f.create().consentRemoteCode(scope, catalog(), signal());
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(4);
  });

  test("revoking one unavailable peer preserves other identities without broadening their grants", async () => {
    const f = fixture(); let offline = false;
    const resolvePeer = (identity: string) => ({ identity, status: offline && identity === machine ? "offline" : "ready", origin, displayName: "Peer" });
    const transport = f.create(resolvePeer);
    await transport.consentRemoteCode(scope, catalog(), signal());
    await transport.consentRemoteCode({ ...scope, machine: other }, catalog(), signal());
    offline = true;
    await expect(transport.consentRemoteCode(scope, catalog(), signal())).rejects.toThrow("unavailable");
    expect(JSON.parse(f.stored.get(storageKey)!).map((entry: [string, string]) => entry[0])).toEqual([other]);
    offline = false;
    const reload = f.create(resolvePeer);
    await reload.consentRemoteCode({ ...scope, machine: other }, catalog(), signal());
    expect(f.prompts).toBe(2);
    await reload.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(3);
  });

  test("write failure during invalidation removes stale persisted grants and retains only current memory", async () => {
    const f = fixture(); const resolvePeer = (identity: string) => ({ identity, status: "ready", origin, displayName: "Peer" });
    const transport = f.create(resolvePeer);
    await transport.consentRemoteCode(scope, catalog(), signal());
    await transport.consentRemoteCode({ ...scope, machine: other }, catalog(), signal());
    f.faults.write = true;
    await transport.consentRemoteCode(scope, catalog([]), signal());
    expect(f.stored.has(storageKey)).toBe(false);
    await transport.consentRemoteCode(scope, catalog([]), signal());
    expect(f.prompts).toBe(3);
    await f.create(resolvePeer).consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(4);
  });

  test("aborts and peer changes during the prompt cannot grant persistent trust", async () => {
    const f = fixture();
    for (const abort of [true, false]) {
      const controller = new AbortController();
      const transport = new SelectedHostExtensionTransport({ resolvePeer: () => ({ identity: machine, status: "ready", origin: controller.signal.aborted ? "https://changed.example.ts.net" : origin, displayName: "Peer" }),
        prompt: async () => { controller.abort(); return {}; } });
      expect(await transport.consentRemoteCode(scope, catalog(), abort ? controller.signal : signal())).toBe(false);
      expect(f.stored.has(storageKey)).toBe(false);
    }
  });

  test("both memory and persisted maps evict the oldest identity beyond 16", async () => {
    const f = fixture(); const transport = f.create(identity => ({ identity, status: "ready", origin, displayName: "Peer" }));
    const identities = Array.from({ length: 17 }, (_, i) => `node-${i}:11111111-1111-4111-8111-111111111111`);
    for (const identity of identities) await transport.consentRemoteCode({ ...scope, machine: identity }, catalog(), signal());
    const stored = JSON.parse(f.stored.get(storageKey)!);
    expect(stored).toHaveLength(16);
    expect(stored.map((entry: [string, string]) => entry[0])).toEqual(identities.slice(1));
    const reloaded = f.create(identity => ({ identity, status: "ready", origin, displayName: "Peer" }));
    await reloaded.consentRemoteCode({ ...scope, machine: identities[1] }, catalog(), signal());
    expect(f.prompts).toBe(17);
    await transport.consentRemoteCode({ ...scope, machine: identities[0] }, catalog(), signal());
    expect(f.prompts).toBe(18);
    await reloaded.consentRemoteCode({ ...scope, machine: identities[0] }, catalog(), signal());
    expect(f.prompts).toBe(19);
  });

  test.each(["{bad", "null", "{}", '[["bad-identity","key"]]', JSON.stringify([[machine, 42]]), JSON.stringify([[machine, "key", "extra"]]),
    JSON.stringify(Array.from({ length: 17 }, (_, i) => [`node-${i}:11111111-1111-4111-8111-111111111111`, "key"])),
    JSON.stringify([[machine, "x".repeat(256 * 1024 + 1)]]), " ".repeat(16 * 256 * 1024 + 1),
    JSON.stringify([[machine, `${origin}|${JSON.stringify([[item.installationId, item.extensionId, item.package.digest, item.ui!.path, item.ui!.digest]])}`], ["invalid", "key"]]),
    JSON.stringify([[machine, "key"], [machine, "key"]])])("malformed or oversized persisted shape #%# never grants trust", async raw => {
    const f = fixture(); f.stored.set(storageKey, raw);
    const transport = f.create();
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(1);
    await transport.consentRemoteCode(scope, catalog(), signal());
    expect(f.prompts).toBe(1);
  });
});
