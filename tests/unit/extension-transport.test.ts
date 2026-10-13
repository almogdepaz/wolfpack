import { afterEach, describe, expect, test } from "bun:test";
import { extensionProxySuffix, SelectedHostExtensionTransport } from "../../public/extension-transport.ts";

const machine = "node-a:11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";
const asset = `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`;
const saved = new Map<string, PropertyDescriptor | undefined>();
function browserGlobals(): void {
  for (const [key, value] of Object.entries({ location: { href: "http://localhost/", origin: "http://localhost" }, sessionStorage: { getItem: () => "{}" }, localStorage: { getItem: () => null } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
}
function restoreBrowserGlobals(): void {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
}
afterEach(restoreBrowserGlobals);
const readyPeer = { identity: machine, status: "ready", origin: "https://peer.example.ts.net", displayName: "Peer" };
describe("selected host extension transport", () => {
  test("browser fixture restores readonly descriptors and absent globals exactly", () => {
    const original = new Map(["location", "sessionStorage", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const readonly = { configurable: true, enumerable: false, writable: false, value: { origin: "http://readonly.test/" } };
    try {
      Object.defineProperty(globalThis, "location", readonly);
      Reflect.deleteProperty(globalThis, "sessionStorage");
      browserGlobals();
      expect(globalThis.location.origin).toBe("http://localhost");
      restoreBrowserGlobals();
      expect(Object.getOwnPropertyDescriptor(globalThis, "location")).toEqual(readonly);
      expect(Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(original.get("localStorage"));
    } finally {
      restoreBrowserGlobals();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  test("aborts uncooperative transport", async () => {
    browserGlobals();
    let finish!: (value: Response) => void;
    const controller = new AbortController();
    const transport = new SelectedHostExtensionTransport({ resolvePeer: () => readyPeer, authFetch: async () => new Promise(resolve => { finish = resolve; }) });
    const pending = transport.request({ sessionId: session, machine }, "/api/extensions", { signal: controller.signal });
    controller.abort(); finish(Response.json({ safeMode: false, installations: [] }));
    await expect(pending).rejects.toThrow();
  });
  test("rejects a late body when peer routing authority is lost", async () => {
    browserGlobals(); let status = "ready";
    let finish!: (value: Response) => void;
    const transport = new SelectedHostExtensionTransport({ resolvePeer: () => ({ ...readyPeer, status }), authFetch: async () => new Promise(resolve => { finish = resolve; }) });
    const pending = transport.request({ sessionId: session, machine }, "/api/extensions", {});
    status = "offline"; finish(Response.json({ safeMode: false, installations: [] }));
    await expect(pending).rejects.toThrow();
  });
  test("rejects oversized chunked catalog bodies", async () => {
    browserGlobals();
    const oversized = new SelectedHostExtensionTransport({ resolvePeer: () => readyPeer, authFetch: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(256 * 1024 + 1)); stream.close(); } }), { headers: { "Content-Type": "application/json" } }) });
    await expect(oversized.request({ sessionId: session, machine }, "/api/extensions", {})).rejects.toThrow();
  });
  test("bounds blob bodies by the blob limit rather than the catalog limit", async () => {
    browserGlobals();
    const blob = `/api/extensions/blobs/notes/${"a".repeat(64)}`;
    const serve = (size: number) => new SelectedHostExtensionTransport({ resolvePeer: () => readyPeer, authFetch: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(size)); stream.close(); } }), { headers: { "Content-Type": "application/octet-stream" } }) });
    const accepted = await serve(1024 * 1024).request({ sessionId: session, machine }, blob, {});
    expect(accepted.status).toBe(200);
    await expect(serve(1024 * 1024 + 1).request({ sessionId: session, machine }, blob, {})).rejects.toThrow("exceeds limit");
  });
  test("bounds typed peer-auth error bodies and their complete acquisition deadline", async () => {
    browserGlobals();
    let stream!: ReadableStreamDefaultController<Uint8Array>, cancellations = 0;
    const transport = new SelectedHostExtensionTransport({ resolvePeer: () => readyPeer, timeoutMs: 20,
      authFetch: async () => new Response(new ReadableStream({ start(value) { stream = value; value.enqueue(new TextEncoder().encode('{"error":')); }, cancel() { cancellations++; return new Promise(() => {}); } }), { status: 401, headers: { "Content-Type": "application/json" } }),
    });
    const pending = transport.request({ sessionId: session, machine }, "/api/extensions", {}).then(() => "resolved", () => "rejected");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, new Promise<string>(resolve => { timer = setTimeout(() => resolve("guard-expired"), 250); })]);
      expect(result).toBe("rejected"); expect(cancellations).toBe(1);
    } finally { clearTimeout(timer); try { stream.error(new Error("owned fixture cleanup")); } catch {} await pending; }
    const oversized = new SelectedHostExtensionTransport({ resolvePeer: () => readyPeer, authFetch: async () => new Response(new Uint8Array(2049), { status: 401, headers: { "Content-Type": "application/json" } }) });
    await expect(oversized.request({ sessionId: session, machine }, "/api/extensions", {})).rejects.toThrow();
  });
  test("maps only canonical read capabilities without accepting alias paths", () => {
    expect(extensionProxySuffix("/api/extensions")).toBe("catalog");
    expect(extensionProxySuffix(asset)).toBe(asset.slice("/api/extensions/".length));
    expect(extensionProxySuffix(`/api/extensions/documents/notes/context?session=${session}`)).toBe(`documents/notes/context?session=${session}`);
    expect(extensionProxySuffix(`/api/extensions/blobs/notes/${"a".repeat(64)}`)).toBe(`blobs/notes/${"a".repeat(64)}`);
    for (const path of [`/api/extensions/blobs/notes/${"a".repeat(64)}?session=${session}`, `/api/extensions/blobs/notes/${"A".repeat(64)}`, `/api/extensions/blobs/notes/${"a".repeat(63)}`, `/api/extensions/blobs/notes/${"a".repeat(64)}/`, `/api/extensions/blobs/${"a".repeat(64)}`]) expect(() => extensionProxySuffix(path)).toThrow();
    for (const path of [asset.replace("dist/ui", "dist//ui"), asset.replace("dist/ui", "dist/../ui"), asset.replace("dist/ui", "dist/%2e%2e/ui"), asset + "?token=secret", "https://evil.test/api/extensions", "/api/extensions/", "/api/extensions/documents/notes/context?session=" + session + "&session=" + session, "/api/extensions/project/git-status/notes?session=" + session + "&path=/tmp"]) {
      expect(() => extensionProxySuffix(path)).toThrow();
    }
  });
  test.each(["offline", "unavailable", "incompatible"])("never falls back to local data for %s peer", async status => {
    let calls = 0;
    const transport = new SelectedHostExtensionTransport({ resolvePeer: () => ({ identity: machine, status, origin: "https://peer.example.ts.net", displayName: "Peer" }), authFetch: async () => { calls++; return Response.json({}); } });
    await expect(transport.request({ sessionId: session, machine }, "/api/extensions", {})).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("rejects a replaced identity, hostile origin and write before contacting a host", async () => {
    let identity = machine, origin = "https://peer.example.ts.net", calls = 0;
    const transport = new SelectedHostExtensionTransport({ resolvePeer: () => ({ identity, origin, status: "ready", displayName: "Peer" }), authFetch: async () => { calls++; return Response.json({}); } });
    identity = "node-b:11111111-1111-4111-8111-111111111111";
    await expect(transport.request({ sessionId: session, machine }, "/api/extensions", {})).rejects.toThrow();
    identity = machine; origin = "http://127.0.0.1";
    await expect(transport.request({ sessionId: session, machine }, "/api/extensions", {})).rejects.toThrow();
    origin = "https://peer.example.ts.net";
    await expect(transport.request({ sessionId: session, machine }, "/api/extensions", { method: "POST" })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
