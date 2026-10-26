import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WidgetPanels } from "../../public/widget-panels.ts";
import { ContextViewRegistry } from "../../public/context-view-registry.ts";
import { ExtensionHost, type ExtensionHostOptions, type SelectedExtensionScope } from "../../public/extension-host.ts";
import { TerminalLayoutRegistry } from "../../public/terminal-layout-registry.ts";
import { equalGridLayout } from "../../src/extensions/layout-contract.ts";
import { WidgetLayout } from "../../public/widget-layout.ts";
import type { ExtensionRegistration, ExtensionRegistrationHost, ExtensionViewContext } from "../../src/extensions/sdk.ts";

class FakeElement extends EventTarget {
  constructor(readonly tagName = "div") { super(); }
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = "";
  hidden = false;
  type = "";
  private readonly attributes = new Map<string, string>();
  append(child: FakeElement) { child.remove(); child.parentElement = this; this.children.push(child); }
  prepend(child: FakeElement) { child.remove(); child.parentElement = this; this.children.unshift(child); }
  insertBefore(child: FakeElement, before: FakeElement | null) { child.remove(); child.parentElement = this; const at = before ? this.children.indexOf(before) : -1; if (at < 0) this.children.push(child); else this.children.splice(at, 0, child); }
  contains(child: FakeElement): boolean { return child === this || this.children.some(item => item.contains(child)); }
  focus() {}
  remove() { if (!this.parentElement) return; const at = this.parentElement.children.indexOf(this); if (at >= 0) this.parentElement.children.splice(at, 1); this.parentElement = null; }
  replaceChildren() { for (const child of this.children) child.parentElement = null; this.children.length = 0; }
  // Model the inline SVG roots used by host chrome; browser tests cover their paint.
  set innerHTML(markup: string) {
    this.replaceChildren();
    for (const match of markup.matchAll(/<svg\b([^>]*)>/g)) {
      const svg = new FakeElement("svg");
      for (const attribute of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) svg.setAttribute(attribute[1]!, attribute[2]!);
      this.append(svg);
    }
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector<T extends FakeElement>(selector: string): T | null {
    const name = selector.match(/^\[data-([^\]]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return (this.children.find(child => name ? name in child.dataset : child.tagName === selector) ?? this.children.map(child => child.querySelector<T>(selector)).find(Boolean)) as T ?? null;
  }
}

const documentListeners = new Map<string, unknown>();
(globalThis as Record<string, unknown>).document = {
  visibilityState: "visible",
  createElement: (tagName: string) => new FakeElement(tagName),
  addEventListener: (name: string, listener: unknown) => documentListeners.set(name, listener),
  removeEventListener: (name: string) => documentListeners.delete(name),
};

const installationId = "11111111-1111-4111-8111-111111111111";
let container: FakeElement;
function rightChrome(selector: string): FakeElement | undefined {
  return container.children.filter(child => child.dataset.widgetArea === "right").map(child => child.querySelector(selector)).find((child): child is FakeElement => !!child);
}
afterEach(() => {
  container?.remove();
  documentListeners.clear();
  (document as unknown as { visibilityState: string }).visibilityState = "visible";
});

// Real self-contained package code exercises the host's loader/registration boundary.
const consentBundle = `export default host => { host.registerContextView({ id: "view", title: "Consent view", mount() { return { dispose() {} }; } }); };`;
function consentCatalog() {
  return { safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true,
    package: { name: "notes", version: "1", digest: "a".repeat(64) },
    ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`,
      digest: new Bun.CryptoHasher("sha256").update(consentBundle).digest("hex"), mime: "text/javascript" }, documents: [] }] };
}
function withLoaderLocation() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { href: "http://localhost/", origin: "http://localhost" } });
  return () => { if (descriptor) Object.defineProperty(globalThis, "location", descriptor); else Reflect.deleteProperty(globalThis, "location"); };
}

// Only browser storage/HTTP/prompt and executable import are fixture boundaries.
// The real host, catalog parser, transport and consent lifecycle run unchanged.
function persistedConsentHost() {
  const restoreLocation = withLoaderLocation();
  const saved = new Map(["localStorage", "sessionStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key),
  } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null } });
  const root = document.createElement("div");
  let scope: SelectedExtensionScope = { sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` };
  let status = "ready", inventory: "ui" | "empty" | "disabled" | "no-ui" | "invalid-catalog" = "ui";
  let prompts = 0, imports = 0, requests = 0;
  let prompt: () => Promise<Record<string, string> | null> = async () => ({});
  let nextCatalog: (() => Promise<Response>) | undefined;
  const options: ExtensionHostOptions = { container: root, scope: () => scope,
    resolvePeer: machine => ({ identity: machine, status, origin: "https://peer.example.ts.net", displayName: "Peer" }),
    accessPrompt: async () => { prompts++; return prompt(); },
    authFetch: async input => {
      requests++;
      if (nextCatalog) { const next = nextCatalog; nextCatalog = undefined; return next(); }
      const catalog = consentCatalog();
      if (String(input) === "/api/extensions" || inventory === "empty") return Response.json({ safeMode: false, installations: [] });
      if (inventory === "invalid-catalog") return Response.json({ invalid: true });
      if (inventory === "disabled") catalog.installations[0]!.enabled = false;
      if (inventory === "no-ui") return Response.json({ ...catalog, installations: catalog.installations.map(({ ui: _ui, ...item }) => item) });
      return Response.json(catalog);
    },
    // The generic loader's import boundary is injected; no host decision is replaced.
    bundleLoader: async <T,>() => ({ default() { imports++; } }) as T,
  };
  let host = new ExtensionHost(options);
  return { stored, get host() { return host; }, get scope() { return scope; }, set scope(value: SelectedExtensionScope) { scope = value; },
    set status(value: string) { status = value; }, set inventory(value: typeof inventory) { inventory = value; },
    set prompt(value: typeof prompt) { prompt = value; }, set nextCatalog(value: typeof nextCatalog) { nextCatalog = value; },
    get prompts() { return prompts; }, get imports() { return imports; }, get requests() { return requests; },
    recreate() { host.dispose(); host = new ExtensionHost(options); },
    dispose() {
      host.dispose(); root.remove(); restoreLocation();
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

describe("ExtensionHost", () => {
  test.each((["unavailable", "empty", "disabled", "no-ui", "invalid-catalog"] as const).flatMap(transition =>
    [false, true].map(recreate => [transition, recreate] as const)))("real host retires consent on %s before recovery (new host: %s)", async (transition, recreate) => {
    const f = persistedConsentHost();
    try {
      await f.host.refresh();
      expect(f.prompts).toBe(1); expect(f.imports).toBe(1);
      expect(f.stored.has("wp-extension-code-consent:v1")).toBe(true);
      if (transition === "unavailable") { f.status = "unavailable"; f.scope = { ...f.scope, unavailable: "Peer unavailable" }; }
      else f.inventory = transition;
      await f.host.refresh();
      expect(f.prompts).toBe(1); // an empty inventory never opens a trust prompt
      expect(f.requests).toBe(transition === "unavailable" ? 1 : 2);
      expect(f.stored.has("wp-extension-code-consent:v1")).toBe(false);
      f.status = "ready"; f.inventory = "ui"; f.scope = { sessionId: f.scope.sessionId, machine: f.scope.machine };
      if (recreate) f.recreate();
      await f.host.refresh();
      expect(f.prompts).toBe(2); expect(f.imports).toBe(2);
      // Once reapproved, a harmless host recreation still reuses exact consent.
      f.recreate(); await f.host.refresh();
      expect(f.prompts).toBe(2); expect(f.imports).toBe(3);
    } finally { f.dispose(); }
  });

  test("real host session, empty selection and local scope switches alone retain exact peer consent", async () => {
    const f = persistedConsentHost();
    try {
      await f.host.refresh();
      f.scope = { ...f.scope, sessionId: "33333333-3333-4333-8333-333333333333" };
      await f.host.refresh();
      f.scope = { ...f.scope, sessionId: null }; await f.host.refresh();
      f.scope = { sessionId: "22222222-2222-4222-8222-222222222222" }; await f.host.refresh();
      f.scope = { ...f.scope, machine: `node-a:${installationId}` }; await f.host.refresh();
      expect(f.prompts).toBe(1);
      f.recreate(); await f.host.refresh();
      expect(f.prompts).toBe(1);
    } finally { f.dispose(); }
  });

  test("real transport cannot persist a late positive host prompt after unavailable invalidation", async () => {
    const f = persistedConsentHost();
    let release!: (value: Record<string, string>) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    f.prompt = () => { began(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.host.refresh();
    try {
      await started;
      f.status = "unavailable"; f.scope = { ...f.scope, unavailable: "Peer unavailable" };
      await f.host.refresh();
      release({}); await pending;
      expect(f.stored.has("wp-extension-code-consent:v1")).toBe(false);
      expect(f.imports).toBe(0);
      f.status = "ready"; f.scope = { sessionId: f.scope.sessionId, machine: f.scope.machine };
      f.prompt = async () => ({});
      await f.host.refresh();
      expect(f.prompts).toBe(2); expect(f.imports).toBe(1);
    } finally { release?.({}); await pending; f.dispose(); }
  });

  test("stale empty catalog completion cannot revoke a newer host scope's approval", async () => {
    const f = persistedConsentHost();
    let release!: (value: Response) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    try {
      await f.host.refresh();
      f.nextCatalog = () => { began(); return new Promise(resolve => { release = resolve; }); };
      const stale = f.host.refresh(); await started;
      f.scope = { ...f.scope, sessionId: "33333333-3333-4333-8333-333333333333" };
      await f.host.refresh();
      release(Response.json({ safeMode: false, installations: [] })); await stale;
      expect(f.prompts).toBe(1); expect(f.stored.has("wp-extension-code-consent:v1")).toBe(true);
      f.recreate(); await f.host.refresh();
      expect(f.prompts).toBe(1);
    } finally { release?.(Response.json({ safeMode: false, installations: [] })); f.dispose(); }
  });

  test("same-scope refresh retains pending remote consent until a positive decision", async () => {
    const restore = withLoaderLocation();
    const root = document.createElement("div");
    let requests = 0, prompts = 0, assets = 0;
    let decide!: (value: boolean) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const signals: AbortSignal[] = [];
    const host = new ExtensionHost({ container: root,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` }),
      selectedHostFetch: async (_scope, path) => {
        if (path === "/api/extensions") { requests++; return Response.json(consentCatalog()); }
        assets++; return new Response(consentBundle, { headers: { "Content-Type": "text/javascript" } });
      },
      consentRemoteCode: (_scope, _catalog, signal) => {
        prompts++; signals.push(signal); began(); return new Promise(resolve => { decide = resolve; });
      },
    });
    try {
      const first = host.refresh(); await started;
      const duplicate = host.refresh();
      expect(signals[0]!.aborted).toBe(false);
      expect(requests).toBe(1); expect(prompts).toBe(1);
      expect(assets).toBe(0); expect(host.availablePanels).toHaveLength(0);
      decide(true); await Promise.all([first, duplicate]);
      expect(requests).toBe(1); expect(prompts).toBe(1); expect(assets).toBe(1);
      expect(host.availablePanels.map(panel => panel.id)).toEqual(["notes/view"]);
    } finally { decide?.(false); host.dispose(); restore(); root.remove(); }
  });

  test.each(["scope", "unavailable", "safe-mode", "dispose"])("pending remote consent cancels and fences a stale positive decision on %s", async transition => {
    const root = document.createElement("div");
    let scope: { sessionId: string; machine: string; unavailable?: string } = { sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` };
    let safeMode = false, requests = 0, assets = 0, prompts = 0;
    let signal: AbortSignal | undefined;
    let decide!: (value: boolean) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const host = new ExtensionHost({ container: root, scope: () => scope, safeMode: () => safeMode,
      selectedHostFetch: async (_scope, path) => {
        if (path !== "/api/extensions") { assets++; return new Response("unexpected asset"); }
        return Response.json(++requests === 1 ? consentCatalog() : { safeMode: false, installations: [] });
      },
      consentRemoteCode: (_scope, _catalog, active) => { prompts++; signal = active; began(); return new Promise(resolve => { decide = resolve; }); },
    });
    try {
      const first = host.refresh(); await started;
      if (transition === "scope") scope = { ...scope, machine: `node-b:${installationId}` };
      if (transition === "unavailable") scope = { ...scope, unavailable: "Peer unavailable" };
      if (transition === "safe-mode") safeMode = true;
      if (transition === "dispose") host.dispose(); else await host.refresh();
      expect(signal?.aborted).toBe(true);
      decide(true); await first;
      expect(assets).toBe(0); expect(prompts).toBe(1); expect(host.availablePanels).toHaveLength(0);
      expect(requests).toBe(transition === "scope" ? 2 : 1);
    } finally { decide?.(false); host.dispose(); root.remove(); }
  });

  test("declined remote consent releases the pending operation so refresh can prompt again", async () => {
    const root = document.createElement("div");
    let requests = 0, prompts = 0, assets = 0;
    const host = new ExtensionHost({ container: root,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` }),
      selectedHostFetch: async (_scope, path) => { if (path === "/api/extensions") { requests++; return Response.json(consentCatalog()); } assets++; return new Response("unexpected asset"); },
      consentRemoteCode: async () => { prompts++; return false; },
    });
    try {
      await host.refresh(); await host.refresh();
      expect(requests).toBe(2); expect(prompts).toBe(2); expect(assets).toBe(0); expect(host.availablePanels).toHaveLength(0);
    } finally { host.dispose(); root.remove(); }
  });
  test("refresh after positive consent revalidates catalog rather than coalescing package loading", async () => {
    const restore = withLoaderLocation();
    const root = document.createElement("div");
    let requests = 0, prompts = 0;
    let assetSignal: AbortSignal | null | undefined;
    let began!: () => void, release!: (response: Response) => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const host = new ExtensionHost({ container: root,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` }),
      consentRemoteCode: async () => { prompts++; return true; },
      selectedHostFetch: async (_scope, path, init) => {
        if (path === "/api/extensions") return Response.json(++requests === 1 ? consentCatalog() : { safeMode: false, installations: [] });
        assetSignal = init.signal; began(); return new Promise(resolve => { release = resolve; });
      },
    });
    try {
      const first = host.refresh(); await started;
      const second = host.refresh();
      expect(assetSignal?.aborted).toBe(true); expect(requests).toBe(2);
      await Promise.all([first, second]);
      expect(prompts).toBe(1); expect(host.availablePanels).toHaveLength(0);
    } finally { release?.(new Response(consentBundle)); host.dispose(); restore(); root.remove(); }
  });

  test.each(["scope", "unavailable", "safe-mode", "dispose"])("obsolete loader rejection cannot repaint the current host on %s", async transition => {
    const restore = withLoaderLocation();
    const root = document.createElement("div");
    let scope: { sessionId: string; unavailable?: string } = { sessionId: "22222222-2222-4222-8222-222222222222" };
    let safeMode = false, requests = 0, paints = 0;
    let assetSignal: AbortSignal | null | undefined;
    let began!: () => void, releaseAsset!: (response: Response) => void, releaseCatalog!: (response: Response) => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const host = new ExtensionHost({ container: root, scope: () => scope, safeMode: () => safeMode,
      onChange: () => { paints++; },
      authFetch: async (input, init) => {
        if (String(input) === "/api/extensions") {
          if (++requests === 1) return Response.json(consentCatalog());
          return new Promise(resolve => { releaseCatalog = resolve; });
        }
        assetSignal = init?.signal; began(); return new Promise(resolve => { releaseAsset = resolve; });
      },
    });
    try {
      const first = host.refresh(); await started;
      if (transition === "scope") scope = { sessionId: "33333333-3333-4333-8333-333333333333" };
      if (transition === "unavailable") scope = { ...scope, unavailable: "Peer unavailable" };
      if (transition === "safe-mode") safeMode = true;
      const second = transition === "dispose" ? (host.dispose(), Promise.resolve()) : host.refresh();
      expect(assetSignal?.aborted).toBe(true);
      const currentPaints = paints;
      const currentChildren = root.children.length;
      await first; // The real loader rejects the ignored/cancelled network boundary.
      expect(paints).toBe(currentPaints);
      expect(root.children.length).toBe(currentChildren);
      expect(host.availablePanels).toHaveLength(0);
      releaseCatalog?.(Response.json({ safeMode: false, installations: [] })); await second;
    } finally {
      releaseAsset?.(new Response(consentBundle)); releaseCatalog?.(Response.json({ safeMode: false, installations: [] }));
      host.dispose(); restore(); root.remove();
    }
  });

  test.each(["registration", "load"])("current-scope genuine %s failure still displays an error and cleans owned contributions", async failure => {
    const restore = withLoaderLocation();
    const root = document.createElement("div");
    const messages: string[] = [];
    let layoutCleanups = 0;
    const brokenBundle = `export default host => { host.registerTerminalLayout({ id: "layout", title: "Broken layout", arrange() { return {}; } }); throw new Error("registration failed"); };`;
    const catalog = consentCatalog();
    catalog.installations.push({ ...catalog.installations[0]!, extensionId: "broken",
      ui: { ...catalog.installations[0]!.ui, url: `/api/extensions/assets/broken/${"a".repeat(64)}/ui.js`,
        digest: new Bun.CryptoHasher("sha256").update(brokenBundle).digest("hex") } });
    const host = new ExtensionHost({ container: root,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      registerLayout: () => () => { layoutCleanups++; },
      onChange: () => { const message = root.querySelector("[data-extension-status]")?.textContent; if (message) messages.push(message); },
      authFetch: async input => {
        if (String(input) === "/api/extensions") return Response.json(catalog);
        const broken = String(input).includes("/broken/");
        return new Response(broken ? brokenBundle : consentBundle, { headers: { "Content-Type": broken && failure === "load" ? "text/plain" : "text/javascript" } });
      },
    });
    try {
      await host.refresh();
      expect(messages).toContain("Extension broken could not be registered.");
      expect(host.availablePanels.map(panel => panel.id)).toEqual(["notes/view"]);
      expect(layoutCleanups).toBe(failure === "registration" ? 1 : 0);
    } finally { host.dispose(); restore(); root.remove(); }
  });

  test("a different machine with the same session UUID aborts the old catalog body and reacquires", async () => {
    container = new FakeElement();
    let selected = { sessionId: "22222222-2222-4222-8222-222222222222", machine: "node-a:11111111-1111-4111-8111-111111111111" };
    let requests = 0;
    let oldSignal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const fetchCatalog: NonNullable<ExtensionHostOptions["authFetch"]> = async (_input, options) => {
        requests++;
        if (requests > 1) return Response.json({ safeMode: false, installations: [] });
        oldSignal = options?.signal as AbortSignal;
        return { ok: true, json: () => { bodyStarted(); return new Promise(resolve => { finish = resolve; }); } } as Response;
    };
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => selected,
      authFetch: fetchCatalog,
      selectedHostFetch: (_scope, input, options) => fetchCatalog(input, options),
    });
    try {
      const first = host.refresh();
      await started;
      selected = { ...selected, machine: "node-b:33333333-3333-4333-8333-333333333333" };
      const second = host.refresh();
      // A switch must invalidate synchronously, before the old body cooperates.
      expect(oldSignal?.aborted).toBe(true);
      expect(requests).toBe(2);
      finish({ safeMode: false, installations: [] });
      await Promise.all([first, second]);
    } finally { finish?.({ safeMode: false, installations: [] }); host.dispose(); }
  });

  test("ready remote catalog uses only the current-host proxy and the selected peer credential channel", async () => {
    container = new FakeElement();
    const machine = `node-a:${installationId}`;
    const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ location: { href: "http://localhost/", origin: "http://localhost" }, sessionStorage: { getItem: () => JSON.stringify({ "https://peer.example.ts.net": "peer-token", "http://localhost": "local-token" }) }, localStorage: { getItem: () => null } })) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const requests: Array<{ path: string; headers: Headers }> = [];
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine }),
      resolvePeer: () => ({ identity: machine, status: "ready", origin: "https://peer.example.ts.net", displayName: "Peer" }),
      authFetch: async (input, options) => { requests.push({ path: String(input), headers: new Headers(options?.headers) }); return Response.json({ safeMode: false, installations: [] }); },
    });
    try {
      await host.refresh();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.path).toBe(`/api/extensions/peer/${encodeURIComponent(machine)}/catalog`);
      expect(requests[0]!.headers.get("X-Wolfpack-Extension-Peer-Authorization")).toBe("Bearer peer-token");
      expect(requests[0]!.headers.get("Authorization")).toBeNull();
    } finally {
      host.dispose();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("remote code requires local consent before import", async () => {
    container = new FakeElement(); let imports = 0, prompts = 0;
    const host = new ExtensionHost({ container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` }),
      selectedHostFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true,
        package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      consentRemoteCode: async () => { prompts++; return false; },
      bundleLoader: (async () => { imports++; return { default() {} }; }) as never,
    });
    try { await host.refresh(); expect(prompts).toBe(1); expect(imports).toBe(0); expect(host.availablePanels).toHaveLength(0); }
    finally { host.dispose(); }
  });

  test("captures machine SDK reads and storage, disposes registrations and reuses only verified code on return", async () => {
    container = new FakeElement();
    const values = new Map<string, string>();
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
    let selected: { sessionId: string; machine: string; unavailable?: string } = { sessionId: "22222222-2222-4222-8222-222222222222", machine: `node-a:${installationId}` };
    let context!: ExtensionViewContext, imports = 0, registrations = 0, disposals = 0, layoutDisposals = 0;
    const readMachines: string[] = [];
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => selected,
      consentRemoteCode: async () => true,
      registerLayout: () => () => { layoutDisposals++; },
      selectedHostFetch: async (scope, path) => {
        if (path === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true,
          package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "context", schemaVersion: 1 }] }] });
        if (path.includes("git-diff")) return Response.json({ installationId, scopeSessionId: selected.sessionId, extensionId: "notes", diff: { state: scope.machine === `node-a:${installationId}` ? "not-repository" : "wrong-machine" } });
        readMachines.push(scope.machine!);
        if (path.includes("git-status")) return Response.json({ installationId, scopeSessionId: selected.sessionId, extensionId: "notes", status: { state: "not-repository" } });
        return Response.json({ installationId, scopeSessionId: selected.sessionId, extensionId: "notes", documentId: "context", revision: 1, document: scope.machine });
      },
      bundleLoader: (async () => { imports++; return { default: (register: ExtensionRegistrationHost) => {
        registrations++;
        register.registerTerminalLayout({ id: "layout", title: "Selected machine layout", arrange: equalGridLayout });
        register.registerContextView({ id: "notes", title: "Notes", mount(_root, value) { context = value; return { dispose() { disposals++; } }; } });
      } }; }) as never,
    });
    try {
      await host.refresh(); host.select();
      expect(context.scope).toEqual({ installationId, sessionId: selected.sessionId });
      const old = context; old.storage.set("draft", "a");
      expect(await old.documents.read("context")).toBe(selected.machine);
      await old.project.gitStatus(); expect(await old.project.gitDiff()).toEqual({ state: "not-repository" });
      selected = { ...selected, machine: `node-b:${installationId}` };
      await host.refresh(); host.select();
      expect(old.signal.aborted).toBe(true); expect(disposals).toBe(1);
      expect(context.storage.get("draft")).toBeNull();
      await expect(old.documents.read("context")).rejects.toThrow();
      expect(() => old.documents.subscribe("context", () => {})).toThrow("stale");
      expect(await context.documents.read("context")).toBe(selected.machine);
      await context.project.gitStatus();
      selected = { ...selected, machine: `node-a:${installationId}` };
      await host.refresh(); host.select();
      expect(context.storage.get("draft")).toBe("a");
      expect(imports).toBe(2); expect(registrations).toBe(3);
      expect(readMachines).toEqual([`node-a:${installationId}`, `node-a:${installationId}`, `node-b:${installationId}`, `node-b:${installationId}`]);
      const retained = context;
      selected = { ...selected, unavailable: "Verified peer is offline" };
      await host.refresh();
      expect(retained.signal.aborted).toBe(true); expect(layoutDisposals).toBe(3);
      expect(host.availablePanels).toHaveLength(0);
      selected = { sessionId: selected.sessionId, machine: `node-a:${installationId}` };
      await host.refresh(); host.select();
      expect(imports).toBe(3); expect(registrations).toBe(4);
    } finally { host.dispose(); if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage"); }
  });

  test("blob integrity/staleness, compose bounds/mismatch and allowlisted theme snapshot", async () => {
    container = new FakeElement(); const id = "22222222-2222-4222-8222-222222222222";
    let selected = { sessionId: id }, context!: ExtensionViewContext, mismatch = false, composed = "", corrupt = false;
    let release: ((response: Response) => void) | undefined, pending = false, oversize = false, failed = false, cancelled = false;
    const bytes = new Uint8Array([0, 255, 4]); const digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    const previous = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (key: string) => key === "--accent" ? "  green  " : key === "--secret" ? "secret" : "" })) as never;
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => selected,
      composeTerminalInput: (session, text) => { expect(session).toBe(id); if (mismatch) return false; composed = text; return true; },
      authFetch: async (input, options) => {
        if (String(input) === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "stage", enabled: true, blobs: { maxBlobBytes: 64 }, package: { name: "stage", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/stage/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
        expect(options?.cache).toBe("no-store"); expect(String(input)).toBe(`/api/extensions/blobs/stage/${digest}`);
        if (failed) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
        return pending ? new Promise(resolve => { release = resolve; }) : new Response(oversize ? new Uint8Array(65) : corrupt ? new Uint8Array([1]) : bytes);
      }, bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "view", title: "Stage", mount(_root, value) { context = value; return { dispose() {} }; } }) })) as never,
    });
    try {
      await host.refresh(); host.select(); expect(context.theme).toEqual({ "--accent": "green" }); expect(Object.isFrozen(context.theme)).toBe(true);
      expect(await context.blobs!.read(digest)).toEqual(bytes); corrupt = true; await expect(context.blobs!.read(digest)).rejects.toThrow("digest"); corrupt = false; oversize = true; await expect(context.blobs!.read(digest)).rejects.toThrow("limit"); oversize = false;
      failed = true; await expect(context.blobs!.read(digest)).rejects.toThrow("unavailable"); expect(cancelled).toBe(true); failed = false;
      context.terminal!.compose("replace me"); expect(composed).toBe("replace me");
      expect(() => context.terminal!.compose("é".repeat(2049))).toThrow(); expect(() => context.terminal!.compose(7 as never)).toThrow();
      mismatch = true; expect(() => context.terminal!.compose("no")).toThrow(); mismatch = false;
      pending = true; const read = context.blobs!.read(digest); selected = { sessionId: "33333333-3333-4333-8333-333333333333" }; await host.refresh(); release!(new Response(bytes)); await expect(read).rejects.toThrow("stale");
    } finally { host.dispose(); globalThis.getComputedStyle = previous; }
    expect(() => context.terminal!.compose("after dispose")).toThrow("stale");
  });
  test("exposes verified blob reads for a selected-machine scope through the selected host fetch", async () => {
    container = new FakeElement();
    const machine = `node-a:${installationId}`;
    const bytes = new Uint8Array([7, 8, 9]); const digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    const reads: Array<[string, string]> = [];
    let context!: ExtensionViewContext;
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222", machine }),
      consentRemoteCode: async () => true,
      selectedHostFetch: async (scope, path) => {
        if (path === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "stage", enabled: true, blobs: { maxBlobBytes: 64 }, package: { name: "stage", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/stage/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
        reads.push([scope.machine!, path]); return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "view", title: "Stage", mount(_root, value) { context = value; return { dispose() {} }; } }) })) as never,
    });
    try {
      await host.refresh(); host.select();
      expect(await context.blobs!.read(digest)).toEqual(bytes);
      expect(reads).toEqual([[machine, `/api/extensions/blobs/stage/${digest}`]]);
    } finally { host.dispose(); }
  });
  test("derives area membership once per render, including native repair and collapsed peek", () => {
    container = new FakeElement();
    const layout = new WidgetLayout({ getItem: () => null, setItem() {} });
    const panels = new WidgetPanels({ container: container as unknown as HTMLElement, layout,
      registry: { setVisibleIds() {} } as unknown as ContextViewRegistry, onSelect() {},
      nativePanels: [{ id: ":terminals", title: "Terminals", element: new FakeElement() as unknown as HTMLElement }],
    });
    panels.setNativePanels([":terminals"]);
    const entry = { id: "widgets/one", contribution: { id: "one", title: "One", mount() { return { dispose() {} }; } } };
    panels.createContainer(entry, new FakeElement() as unknown as HTMLElement, new AbortController().signal);
    panels.update([entry], "", () => null);
    const count = spyOn(layout, "areasFor");
    try {
      panels.setPresentation({ visible: true, desktop: true, focusArea: "main" });
      expect(count).toHaveBeenCalledTimes(1);
      panels.setPresentation({ visible: true, desktop: true, focusArea: null });
      layout.setWidgetState(entry.id, "collapsed");
      // Exercise the retained peek render without counting the initiating input action.
      (panels as any).active.right = entry.id; (panels as any).peekArea = "right";
      count.mockClear();
      panels.update([entry], "", () => null);
      expect(count).toHaveBeenCalledTimes(1);
    } finally { count.mockRestore(); panels.dispose(); }
  });

  test("removing the actual preview owner retains collapsed siblings without cancelling another area's intent", async () => {
    container = new FakeElement();
    const saved = JSON.stringify({ widgets: { "widgets/preview": "collapsed", "widgets/first": "collapsed", "widgets/selected": "collapsed", "widgets/other": "collapsed" }, placements: { "widgets/other": "bottom" }, selected: { right: "widgets/selected" } });
    let preferences = saved;
    const layout = new WidgetLayout({ getItem: () => preferences, setItem(_key, value) { preferences = value; } });
    const wrappers = new Map<string, HTMLElement>();
    let panels!: WidgetPanels;
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement,
      createContainer(entry, wrapper, signal) { wrappers.set(entry.id, wrapper); return panels.createContainer(entry, wrapper, signal); },
      onChange() { panels.update(registry.entries(), registry.diagnostic, () => null); },
    });
    panels = new WidgetPanels({ container: container as unknown as HTMLElement, registry, layout, onSelect(id) { panels.select(id); } });
    registry.setScope({ installationId, sessionId: "22222222-2222-4222-8222-222222222222" });
    let selectedVisible = false;
    const removePreview = registry.register("widgets/preview", { id: "preview", title: "Preview", mount() { return { dispose() {} }; } });
    registry.register("widgets/first", { id: "first", title: "First", mount() { return { dispose() {} }; } });
    registry.register("widgets/selected", { id: "selected", title: "Selected", mount() { return { dispose() {}, setVisible(value) { selectedVisible = value; } }; } });
    registry.register("widgets/other", { id: "other", title: "Other", mount() { return { dispose() {} }; } });
    try {
      panels.select("widgets/selected", false);
      expect(selectedVisible).toBe(true);
      panels.select("widgets/preview", false);
      expect(wrappers.get("widgets/preview")!.dataset.peek).toBe("true");
      expect(wrappers.get("widgets/selected")!.hidden).toBe(true);
      const otherRail = container.children.find(child => child.dataset.widgetArea === "bottom")!;
      otherRail.dispatchEvent(new Event("pointerenter"));
      removePreview();
      expect(selectedVisible).toBe(false);
      expect(wrappers.get("widgets/selected")!.dataset.collapsed).toBe("true");
      expect(wrappers.get("widgets/selected")!.dataset.peek).toBe("false");
      await Bun.sleep(180);
      expect(wrappers.get("widgets/other")?.dataset.peek).toBe("true");
      expect(selectedVisible).toBe(false);
      expect(wrappers.get("widgets/selected")!.dataset.collapsed).toBe("true");
      expect(preferences).toBe(saved);
    } finally { registry.dispose(); panels.dispose(); }
  });

  test("obsolete wrapper abort preserves replacement intent while current owner abort cancels it", async () => {
    container = new FakeElement();
    const layout = new WidgetLayout({ getItem: () => null, setItem() {} });
    const entry = { id: "widgets/one", contribution: { id: "one", title: "One", mount() { return { dispose() {} }; } } };
    layout.setWidgetState(entry.id, "collapsed");
    let selections = 0;
    const panels = new WidgetPanels({ container: container as unknown as HTMLElement, layout,
      registry: { setVisibleIds() {} } as unknown as ContextViewRegistry, onSelect() { selections++; },
    });
    const obsolete = new AbortController(), current = new AbortController();
    const oldWrapper = new FakeElement(), replacement = new FakeElement();
    panels.createContainer(entry, oldWrapper as unknown as HTMLElement, obsolete.signal);
    panels.createContainer(entry, replacement as unknown as HTMLElement, current.signal);
    panels.update([entry], "", () => null);
    try {
      replacement.dispatchEvent(new Event("pointerenter")); await Bun.sleep(180);
      expect(selections).toBe(1); // control: replacement's real hover timer works
      replacement.dispatchEvent(new Event("pointerenter")); obsolete.abort(); await Bun.sleep(180);
      expect(selections).toBe(2);
      replacement.dispatchEvent(new Event("pointerenter")); current.abort(); await Bun.sleep(180);
      expect(selections).toBe(2);
    } finally { panels.dispose(); }
  });

  test("removing an unmounted hover-intent target cannot select its replacement", async () => {
    container = new FakeElement();
    const layout = new WidgetLayout({ getItem: () => null, setItem() {} });
    const entries = ["one", "two"].map(id => ({ id: `widgets/${id}`, contribution: { id, title: id, mount() { return { dispose() {} }; } } }));
    for (const entry of entries) layout.setWidgetState(entry.id, "collapsed");
    let selections = 0;
    const panels = new WidgetPanels({ container: container as unknown as HTMLElement, layout,
      registry: { setVisibleIds() {} } as unknown as ContextViewRegistry, onSelect() { selections++; },
    });
    try {
      panels.update(entries, "", () => null);
      const rail = container.children.find(child => child.dataset.widgetArea === "right")!;
      rail.dispatchEvent(new Event("pointerenter"));
      panels.update([entries[1]!], "", () => null);
      await Bun.sleep(180); expect(selections).toBe(0);
      rail.dispatchEvent(new Event("pointerenter"));
      await Bun.sleep(180); expect(selections).toBe(1); // surviving target still works
    } finally { panels.dispose(); }
  });

  test("disposing widget panels cancels a pending hover-intent selection", async () => {
    container = new FakeElement();
    const layout = new WidgetLayout({ getItem: () => null, setItem() {} });
    const entry = { id: "widgets/one", contribution: { id: "one", title: "One", mount() { return { dispose() {} }; } } };
    layout.setWidgetState(entry.id, "collapsed");
    let selections = 0;
    const panels = new WidgetPanels({ container: container as unknown as HTMLElement, layout,
      registry: { setVisibleIds() {} } as unknown as ContextViewRegistry,
      onSelect() { selections++; },
    });
    panels.update([entry], "", () => null);
    const rail = container.children.find(child => child.dataset.widgetArea === "right")!;
    rail.dispatchEvent(new Event("pointerenter"));
    await Bun.sleep(180);
    expect(selections).toBe(1); // control: the real rail arms a working intent timer
    rail.dispatchEvent(new Event("pointerenter"));
    panels.dispose();
    // Cross the actual 150ms intent deadline; disposal must fence its callback.
    await Bun.sleep(180);
    expect(selections).toBe(1);
  });

  test("reconciles a removed focused area before applying same-render visibility", () => {
    container = new FakeElement();
    const terminals = new FakeElement(), sessions = new FakeElement();
    let focus: "left" | "main" = "left";
    const panels = new WidgetPanels({ container: container as unknown as HTMLElement,
      layout: new WidgetLayout({ getItem: () => null, setItem() {} }),
      registry: { setVisibleIds() {} } as unknown as ContextViewRegistry, onSelect() {},
      nativePanels: [{ id: ":terminals", title: "Terminals", element: terminals as unknown as HTMLElement }, { id: ":sessions", title: "Sessions", element: sessions as unknown as HTMLElement }],
      onAreasChange(areas) { if (!areas.includes(focus)) { focus = "main"; panels.setPresentation({ visible: true, desktop: true, focusArea: focus }); } },
    });
    try {
      panels.setNativePanels([":terminals", ":sessions"]);
      panels.setPresentation({ visible: true, desktop: true, focusArea: "left" });
      expect(terminals.hidden).toBe(true);
      panels.setNativePanels([":terminals"]);
      expect(String(focus)).toBe("main"); expect(terminals.hidden).toBe(false);
    } finally { panels.dispose(); }
  });

  test.each(["scope", "unavailable", "safe-mode", "dispose"] as const)("coalesces a pending catalog body and fences ignored cancellation on %s", async transition => {
    container = new FakeElement();
    let scope: { sessionId: string; unavailable?: string } = { sessionId: "22222222-2222-4222-8222-222222222222" };
    let safeMode = false, requests = 0, imports = 0;
    const signals: AbortSignal[] = [];
    let finish!: (value: unknown) => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => scope, safeMode: () => safeMode,
      authFetch: async (_input, options) => {
        requests++; signals.push(options!.signal as AbortSignal);
        if (requests > 1) return Response.json({ safeMode: false, installations: [] });
        return { ok: true, json: () => { bodyStarted(); return new Promise(resolve => { finish = resolve; }); } } as Response;
      }, bundleLoader: (async () => { imports++; return { default() {} }; }) as never,
    });
    try {
      const first = host.refresh(); await started;
      const duplicate = host.refresh(); expect(requests).toBe(1);
      if (transition === "scope") scope = { sessionId: "33333333-3333-4333-8333-333333333333" };
      if (transition === "unavailable") scope = { ...scope, unavailable: "Remote context unavailable" };
      if (transition === "safe-mode") safeMode = true;
      if (transition === "dispose") host.dispose(); else await host.refresh();
      expect(signals[0]!.aborted).toBe(true);
      finish({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
      await Promise.all([first, duplicate]);
      expect(imports).toBe(0); expect(host.availablePanels).toHaveLength(0);
      expect(requests).toBe(transition === "scope" ? 2 : 1);
    } finally { host.dispose(); }
  });
  test("project Git status binds host scope, validates identity and aborts obsolete or caller-cancelled reads", async () => {
    container = new FakeElement();
    const id = "22222222-2222-4222-8222-222222222222";
    let selected: { sessionId: string; unavailable?: string } = { sessionId: id };
    let context!: ExtensionViewContext; let mismatch = false; let requests = 0;
    let requestSignal: AbortSignal | undefined;
    let release: ((response: Response) => void) | undefined;
    const reply = () => Response.json({ installationId, scopeSessionId: mismatch ? "33333333-3333-4333-8333-333333333333" : id, extensionId: "git-view", status: { state: "not-repository" } });
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => selected,
      authFetch: async (input, options) => {
        if (String(input) === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "git-view", enabled: true, package: { name: "git-view-fixture", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/git-view/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
        expect(String(input)).toBe(`/api/extensions/project/git-status/git-view?session=${id}`); requests++; requestSignal = options?.signal as AbortSignal;
        return requests > 2 ? new Promise<Response>(resolve => { release = resolve; }) : reply();
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "git-view", title: "Git view", mount(_root, value) { context = value; return { dispose() {} }; } }) })) as never,
    });
    try {
      await host.refresh(); host.select();
      expect(context.blobs).toBeUndefined(); expect(context.terminal).toBeUndefined();
      expect(await context.project.gitStatus()).toEqual({ state: "not-repository" });
      mismatch = true; await expect(context.project.gitStatus()).rejects.toThrow("identity"); mismatch = false;
      const abort = new AbortController(); const pending = context.project.gitStatus(abort.signal); abort.abort();
      expect(requestSignal?.aborted).toBe(true); release!(reply()); await expect(pending).rejects.toThrow();
      const stale = context.project.gitStatus(); selected = { sessionId: id, unavailable: "Remote scope unavailable" }; await host.refresh();
      expect(requestSignal?.aborted).toBe(true); release!(reply()); await expect(stale).rejects.toThrow();
      await expect(context.project.gitStatus()).rejects.toThrow(); expect(requests).toBe(4);
    } finally { host.dispose(); }
  });
  test("project Git diff binds host scope, validates identity and the diff payload and aborts obsolete or caller-cancelled reads", async () => {
    container = new FakeElement();
    const id = "22222222-2222-4222-8222-222222222222";
    let selected: { sessionId: string; unavailable?: string } = { sessionId: id };
    let context!: ExtensionViewContext; let body: Record<string, unknown> = {}; let requests = 0;
    let requestSignal: AbortSignal | undefined;
    let release: ((response: Response) => void) | undefined;
    const diff = { state: "ready" as const, staged: "diff --git a/a b/a\n", unstaged: "", truncated: true };
    const reply = () => Response.json({ installationId, scopeSessionId: id, extensionId: "git-view", diff, ...body });
    const host = new ExtensionHost({ container: container as unknown as HTMLElement, scope: () => selected,
      authFetch: async (input, options) => {
        if (String(input) === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "git-view", enabled: true, package: { name: "git-view-fixture", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/git-view/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
        expect(String(input)).toBe(`/api/extensions/project/git-diff/git-view?session=${id}`); requests++; requestSignal = options?.signal as AbortSignal;
        return requests > 4 ? new Promise<Response>(resolve => { release = resolve; }) : reply();
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "git-view", title: "Git view", mount(_root, value) { context = value; return { dispose() {} }; } }) })) as never,
    });
    try {
      await host.refresh(); host.select();
      const value = await context.project.gitDiff();
      expect(value).toEqual(diff); expect(Object.isFrozen(value)).toBe(true);
      body = { scopeSessionId: "33333333-3333-4333-8333-333333333333" }; await expect(context.project.gitDiff()).rejects.toThrow("identity");
      body = { diff: undefined, status: { state: "not-repository" } }; await expect(context.project.gitDiff()).rejects.toThrow("invalid project Git diff");
      body = { diff: { ...diff, staged: 7 } }; await expect(context.project.gitDiff()).rejects.toThrow("invalid project Git diff");
      body = {};
      const abort = new AbortController(); const pending = context.project.gitDiff(abort.signal); abort.abort();
      expect(requestSignal?.aborted).toBe(true); release!(reply()); await expect(pending).rejects.toThrow();
      const stale = context.project.gitDiff(); selected = { sessionId: id, unavailable: "Remote scope unavailable" }; await host.refresh();
      expect(requestSignal?.aborted).toBe(true); release!(reply()); await expect(stale).rejects.toThrow();
      await expect(context.project.gitDiff()).rejects.toThrow(); expect(requests).toBe(6);
    } finally { host.dispose(); }
  });
  test("native panels preserve the full 32-view registry bound and recover Main without disposing content", async () => {
    container = new FakeElement();
    const parent = new FakeElement(), terminals = new FakeElement(), sessions = new FakeElement();
    parent.append(terminals); parent.append(sessions); parent.append(container);
    let saved: string | null = null;
    const layout = new WidgetLayout({ getItem: () => saved, setItem: (_key, value) => { saved = value; } });
    let mounts = 0, disposals = 0, visible = false;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement, widgetLayout: layout,
      nativePanels: [{ id: ":terminals", title: "Terminal grid", element: terminals as unknown as HTMLElement }, { id: ":sessions", title: "Sessions", element: sessions as unknown as HTMLElement }],
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "widgets", enabled: true, package: { name: "widgets", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/widgets/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        for (let index = 0; index < 32; index++) register.registerContextView({ id: `view-${index}`, title: `View ${index}`, mount() {
          mounts++; return { dispose() { disposals++; }, setVisible(value) { visible = value; } };
        } });
      } })) as never,
    });
    try {
      host.setNativePanels([":terminals", ":sessions"]);
      expect(terminals.hidden).toBe(false); expect(sessions.hidden).toBe(false);
      await host.refresh(); host.select();
      expect(host.availablePanels).toHaveLength(34); expect(mounts).toBe(0);
      host.select("widgets/view-31"); expect(mounts).toBe(1);
      host.moveWidget("widgets/view-31", "main");
      expect(terminals.hidden).toBe(true); expect(visible).toBe(true);
      const preferences = saved;
      host.moveWidget(":terminals", "bottom");
      expect(terminals.hidden).toBe(true); expect(terminals.dataset.widgetArea).toBe("main");
      expect(saved).toBe(preferences);
      host.setPresentation({ visible: false, desktop: true, focusArea: null });
      expect(terminals.dataset.widgetArea).toBe("main"); expect(visible).toBe(false); expect(saved).toBe(preferences);
      host.select("widgets/view-30"); expect(mounts).toBe(1); // hidden widget actions cannot mount code
      host.setPresentation({ visible: true, desktop: true, focusArea: null }); host.select();
      expect(terminals.dataset.widgetArea).toBe("main"); expect(visible).toBe(true);
      expect(terminals.parentElement).toBe(parent); expect(sessions.parentElement).toBe(parent);
      expect(mounts).toBe(1); expect(disposals).toBe(0);
      host.select(":unknown"); expect(host.diagnostic).toContain("unavailable");
    } finally { host.dispose(); }
    expect(disposals).toBe(1);
  });

  test("unavailable remote scope exposes only native panels without unloading local registrations or preferences", async () => {
    container = new FakeElement();
    let sessionId: string | null = "22222222-2222-4222-8222-222222222222";
    let saved: string | null = null, mounts = 0, disposals = 0, fetches = 0, registrations = 0, unregisters = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      widgetLayout: new WidgetLayout({ getItem: () => saved, setItem: (_key, value) => { saved = value; } }),
      nativePanels: [{ id: ":terminals", title: "Terminal grid", element: new FakeElement() as unknown as HTMLElement }],
      scope: () => sessionId ? { sessionId } : { sessionId: null, unavailable: "Extension context is unavailable for a terminal served by another machine." },
      authFetch: async () => { fetches++; return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }); },
      registerLayout: () => { registrations++; return () => { unregisters++; }; },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "view", title: "Notes", mount() { mounts++; return { dispose() { disposals++; } }; } });
        register.registerTerminalLayout({ id: "recipe", title: "Recipe", arrange: equalGridLayout });
      } })) as never,
    });
    try {
      host.setNativePanels([":terminals"]); await host.refresh(); host.select("notes/view");
      const preferences = saved;
      expect(mounts).toBe(1);
      sessionId = null; await host.refresh();
      expect(host.availablePanels.map(panel => panel.id)).toEqual([":terminals"]);
      expect(rightChrome("[data-extension-status]")).toBeUndefined(); // No empty remote dock.
      host.select("notes/view"); expect(mounts).toBe(1); expect(disposals).toBe(1);
      expect(fetches).toBe(1); expect(registrations).toBe(1); expect(unregisters).toBe(0); expect(saved).toBe(preferences);
      sessionId = "22222222-2222-4222-8222-222222222222"; await host.refresh(); host.select();
      expect(host.availablePanels.map(panel => panel.id)).toEqual([":terminals", "notes/view"]);
      expect(mounts).toBe(2); expect(registrations).toBe(1); expect(unregisters).toBe(0); expect(saved).toBe(preferences);
    } finally { host.dispose(); }
    expect(unregisters).toBe(1);
  });

  test("workspace-wide close keeps native panels and registrations while suppressing SDK mounts in every scope", async () => {
    container = new FakeElement();
    const terminals = new FakeElement(), sessions = new FakeElement();
    let sessionId: string | null = "22222222-2222-4222-8222-222222222222";
    let saved: string | null = null, mounts = 0, disposals = 0, loads = 0, visible = false;
    const layout = new WidgetLayout({ getItem: () => saved, setItem: (_key, value) => { saved = value; } });
    layout.move("notes/view", "main"); layout.closeWidgets();
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement, widgetLayout: layout,
      nativePanels: [{ id: ":terminals", title: "Terminals", element: terminals as unknown as HTMLElement }, { id: ":sessions", title: "Sessions", element: sessions as unknown as HTMLElement }],
      scope: () => sessionId ? { sessionId } : { sessionId: null, unavailable: "Remote context unavailable." },
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => { loads++; return { default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "view", title: "Notes", mount() { mounts++; return { dispose() { disposals++; }, setVisible(value) { visible = value; } }; } });
      } }; }) as never,
    });
    try {
      host.setNativePanels([":terminals", ":sessions"]);
      for (sessionId of [sessionId, "33333333-3333-4333-8333-333333333333", null]) {
        await host.refresh(); host.select();
        expect(host.availablePanels.map(panel => panel.id)).toEqual([":terminals", ":sessions"]);
        expect(terminals.hidden).toBe(false); expect(sessions.hidden).toBe(false); expect(mounts).toBe(0);
      }
      host.reopenWidgets(); expect(layout.widgetsClosed).toBe(false); expect(mounts).toBe(0);
      sessionId = "22222222-2222-4222-8222-222222222222"; await host.refresh(); host.select();
      expect(mounts).toBe(1); expect(visible).toBe(true); expect(terminals.hidden).toBe(true);
      layout.closeWidgets(); host.syncWidgetVisibility();
      expect(visible).toBe(false); expect(disposals).toBe(0); expect(terminals.hidden).toBe(false);
      expect(host.availablePanels.map(panel => panel.id)).toEqual([":terminals", ":sessions"]);
      sessionId = null; await host.refresh();
      expect(disposals).toBe(1); expect(loads).toBe(1);
      expect(layout.preferences.placements).toEqual({ "notes/view": "main" });
      expect(new WidgetLayout({ getItem: () => saved, setItem() {} }).widgetsClosed).toBe(true);
    } finally { host.dispose(); }
  });

  test("independent panels retain content parents, scope and desktop selections through mobile and area focus", async () => {
    container = new FakeElement();
    let saved: string | null = null;
    const layout = new WidgetLayout({ getItem: () => saved, setItem: (_key, value) => { saved = value; } });
    const nodes = new Map<string, HTMLElement>();
    const visible = new Map<string, boolean>();
    const signals: AbortSignal[] = [];
    let mounts = 0; let disposals = 0; let failThird = true;
    const visibilityEvents: string[] = [];
    let sessionId = "22222222-2222-4222-8222-222222222222";
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement, widgetLayout: layout,
      scope: () => ({ sessionId }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "widgets", enabled: true, package: { name: "widgets", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/widgets/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        for (const id of ["one", "two", "three"]) register.registerContextView({ id, title: id, mount(node, context) {
          mounts++; nodes.set(id, node); signals.push(context.signal);
          if (id === "three" && failThird) throw Error("third view failed");
          return { dispose() { disposals++; }, setVisible(value) { visible.set(id, value); visibilityEvents.push(`${id}:${value}`); } };
        } });
      } })) as never,
    });
    await host.refresh(); host.select(); expect(mounts).toBe(0);
    host.select("widgets/one"); host.moveWidget("widgets/one", "bottom");
    host.select("widgets/two");
    expect(visible.get("one")).toBe(true); expect(visible.get("two")).toBe(true);
    const one = nodes.get("one")!; const parent = one.parentElement;
    const beforeFailure = [...visibilityEvents];
    host.select("widgets/three");
    expect(host.diagnostic).toContain("third view failed");
    expect(visibilityEvents).toEqual(beforeFailure);
    expect(visible.get("one")).toBe(true); expect(visible.get("two")).toBe(true);
    failThird = false;
    host.select("widgets/three");
    expect(visible.get("one")).toBe(true); expect(visible.get("two")).toBe(false); expect(visible.get("three")).toBe(true);
    host.setPresentation({ visible: true, desktop: true, focusArea: "bottom" });
    expect(visible.get("one")).toBe(true); expect(visible.get("three")).toBe(false);
    host.setPresentation({ visible: true, desktop: true, focusArea: null });
    expect(visible.get("three")).toBe(true);
    const desktopSaved = saved;
    host.setPresentation({ visible: true, desktop: false, focusArea: null }); host.select();
    host.select("widgets/two");
    expect(visible.get("two")).toBe(true); expect(visible.get("one")).toBe(false); expect(visible.get("three")).toBe(false);
    expect(saved).toBe(desktopSaved);
    host.moveWidget("widgets/two", "bottom"); expect(saved).toBe(desktopSaved);
    host.setPresentation({ visible: true, desktop: true, focusArea: null }); host.select();
    expect(visible.get("one")).toBe(true); expect(visible.get("three")).toBe(true); expect(visible.get("two")).toBe(false);
    expect(nodes.get("one")).toBe(one); expect(one.parentElement).toBe(parent);
    expect(mounts).toBe(4); expect(disposals).toBe(0);
    host.select("unknown/view"); expect(host.diagnostic).toContain("unavailable");
    expect(visible.get("one")).toBe(true); expect(visible.get("three")).toBe(true);
    sessionId = "33333333-3333-4333-8333-333333333333";
    await host.refresh(); expect(disposals).toBe(3); expect(signals.every(signal => signal.aborted)).toBe(true);
    host.select(); expect(mounts).toBe(6);
    host.dispose(); expect(disposals).toBe(5);
  });

  test("both visible areas resume their exact document while an inactive tab stays paused", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const reads = new Map<string, number>();
    const delivered = new Map<string, number>();
    const waiters = new Map<string, () => void>();
    const wait = (id: string, revision: number) => delivered.get(id) === revision ? Promise.resolve() : new Promise<void>(resolve => waiters.set(`${id}:${revision}`, resolve));
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement, scope: () => ({ sessionId }),
      authFetch: async input => {
        const path = String(input);
        if (path === "/api/extensions") return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "widgets", enabled: true, package: { name: "widgets", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/widgets/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: ["one", "two", "three"].map(id => ({ id, schemaVersion: 1 })) }] });
        const url = new URL(path, "http://fixture");
        expect(url.searchParams.get("session")).toBe(sessionId);
        const id = url.pathname.split("/").at(-1)!;
        const revision = (reads.get(id) ?? 0) + 1; reads.set(id, revision);
        return Response.json({ installationId, extensionId: "widgets", documentId: id, scopeSessionId: sessionId, schemaVersion: 1, revision, document: { value: id } });
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        for (const id of ["one", "two", "three"]) register.registerContextView({ id, title: id, mount(_node, context) {
          context.documents.subscribe(id, (_value, revision) => { delivered.set(id, revision); waiters.get(`${id}:${revision}`)?.(); });
          return { dispose() {} };
        } });
      } })) as never,
    });
    try {
      await host.refresh(); host.select("widgets/one"); host.moveWidget("widgets/one", "bottom"); host.select("widgets/two");
      await Promise.all([wait("one", 1), wait("two", 1)]);
      host.select("widgets/three"); await wait("three", 1);
      (document as unknown as { visibilityState: string }).visibilityState = "hidden";
      (documentListeners.get("visibilitychange") as () => void)();
      (document as unknown as { visibilityState: string }).visibilityState = "visible";
      (documentListeners.get("visibilitychange") as () => void)();
      await Promise.all([wait("one", 2), wait("three", 2)]);
      expect(reads.get("two")).toBe(1);
      host.setPresentation({ visible: true, desktop: true, focusArea: "bottom" });
      (document as unknown as { visibilityState: string }).visibilityState = "hidden";
      (documentListeners.get("visibilitychange") as () => void)();
      (document as unknown as { visibilityState: string }).visibilityState = "visible";
      (documentListeners.get("visibilitychange") as () => void)();
      await wait("one", 3);
      expect(reads.get("two")).toBe(1); expect(reads.get("three")).toBe(2);
    } finally { host.dispose(); }
  });

  test("widget visibility gates selection without unloading layouts or retained views", async () => {
    container = new FakeElement();
    let visible = true; let mounts = 0; let disposed = 0; let layoutDisposed = 0;
    const shown: boolean[] = [];
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      widgetVisible: () => visible,
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1", digest: "a".repeat(64) }, ui: { path: "ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      registerLayout: () => () => { layoutDisposed++; },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "one", title: "One", mount() { mounts++; return { dispose() { disposed++; }, setVisible(value) { shown.push(value); } }; } });
        register.registerTerminalLayout({ id: "layout", title: "Layout", arrange: equalGridLayout });
      } })) as never,
    });
    await host.refresh();
    visible = false;
    host.select();
    host.select("notes/one");
    expect(mounts).toBe(0);
    visible = true; host.syncWidgetVisibility();
    expect(mounts).toBe(1);
    expect(host.selectedId).toBe("notes/one");
    visible = false; host.syncWidgetVisibility();
    expect(host.selectedId).toBeNull();
    expect(shown.at(-1)).toBe(false);
    expect(disposed).toBe(0); expect(layoutDisposed).toBe(0);
    host.select("notes/one"); expect(host.selectedId).toBeNull();
    visible = true; host.syncWidgetVisibility();
    expect(host.selectedId).toBe("notes/one"); expect(mounts).toBe(1);
    host.dispose(); expect(disposed).toBe(1); expect(layoutDisposed).toBe(1);
  });

  test("host opt-in opens the sole view while keeping its desktop collapse tab reachable", async () => {
    container = new FakeElement();
    let count = 1; let mounts = 0; let failMount = false;
    const catalog = () => ({ safeMode: false, installations: Array.from({ length: count }, (_, index) => {
      const extensionId = `view${index}`; const digest = String(index).repeat(64);
      return { installationId, extensionId, enabled: true, package: { name: extensionId, version: "1.0.0", digest }, ui: { path: "ui.js", url: `/api/extensions/assets/${extensionId}/${digest}/ui.js`, digest: "a".repeat(64), mime: "text/javascript" }, documents: [] };
    }) });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json(catalog()),
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "context", title: "Context", mount() { mounts++; if (failMount) throw Error("broken view"); return { dispose() {} }; } });
        host.select(); // a partial catalog must not auto-mount even its first registered view
      } })) as never,
    });
    const tabs = () => rightChrome("[data-extension-tabs]")!;
    await host.refresh();
    expect(mounts).toBe(0); // registration alone still does not mount
    expect(tabs().hidden).toBe(false); // fallback selection remains reachable
    expect(host.setShellVisible(false)).toBe(true);
    expect(host.setShellVisible(false)).toBe(false);
    host.select(); expect(mounts).toBe(0); // no automatic mount in a collapsed panel
    expect(host.setShellVisible(true)).toBe(true);
    host.select();
    expect(host.selectedId).toBe("view0/context"); expect(mounts).toBe(1); expect(tabs().hidden).toBe(false);
    host.select(); expect(mounts).toBe(1);
    count = 2; await host.refresh(); host.select();
    expect(tabs().hidden).toBe(false); expect(host.selectedId).toBe("view0/context");
    host.select("view1/context"); expect(mounts).toBe(2);
    count = 1; await host.refresh(); host.select();
    expect(host.selectedId).toBe("view0/context"); expect(tabs().hidden).toBe(false);
    count = 0; await host.refresh(); host.select();
    expect(host.selectedId).toBeNull(); expect(tabs()).toBeUndefined(); // No empty selector/rail.
    count = 1; failMount = true; await host.refresh(); host.select();
    expect(host.selectedId).toBeNull(); expect(tabs().hidden).toBe(false);
    expect(host.diagnostic).toContain("broken view");
    failMount = false; host.select("view0/context");
    expect(tabs().hidden).toBe(false);
    host.dispose();
  });

  test("pauses document polling for a hidden view even while another view remains visible", async () => {
    container = new FakeElement();
    let documentReads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async (input) => {
        const url = String(input);
        if (url.includes("/documents/")) {
          documentReads++;
          return Response.json({ installationId, scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "notes", documentId: "one", revision: documentReads, document: { revision: documentReads } });
        }
        return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] });
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "first", title: "First", mount: (_container, context) => { context.documents.subscribe("one", () => {}); return { dispose() {} }; } });
        register.registerContextView({ id: "second", title: "Second", mount: () => ({ dispose() {} }) });
      } })) as never,
    });
    await host.refresh();
    expect(rightChrome("[data-extension-status]")?.textContent).toBe("Select a context view.");
    host.select("notes/first");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(documentReads).toBe(1);
    host.select("notes/second");
    expect(rightChrome("[data-extension-status]")?.textContent).toBe("");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(documentReads).toBe(1);
    host.dispose();
  });

  test("rejects a catalog that claims more than one host installation identity before loading packages", async () => {
    container = new FakeElement();
    let loads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [
        { installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] },
        { installationId: "33333333-3333-4333-8333-333333333333", extensionId: "other", enabled: true, package: { name: "other", version: "1.0.0", digest: "c".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/other/${"c".repeat(64)}/dist/ui.js`, digest: "d".repeat(64), mime: "text/javascript" }, documents: [] },
      ] }),
      bundleLoader: (async () => { loads++; return {}; }) as never,
    });
    await host.refresh();
    expect(loads).toBe(0);
    expect(rightChrome("[data-extension-status]")).toBeUndefined();
    expect(host.availablePanels).toEqual([]);
    host.dispose();
  });

  test("rejects an asset URL that is not owned by the catalog package", async () => {
    container = new FakeElement();
    let loads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: "/api/extensions/assets/other/c/dist/ui.js", digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => { loads++; return {}; }) as never,
    });
    await host.refresh();
    expect(loads).toBe(0);
    host.dispose();
  });

  test("disabling one package cleans only its owned mounted view", async () => {
    container = new FakeElement();
    let notesEnabled = true;
    const events: string[] = [];
    const installation = (extensionId: string, enabled: boolean) => ({ installationId, extensionId, enabled, package: { name: extensionId, version: "1.0.0", digest: extensionId === "notes" ? "a".repeat(64) : "c".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/${extensionId}/${extensionId === "notes" ? "a".repeat(64) : "c".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" as const }, documents: [] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [installation("notes", notesEnabled), installation("tasks", true)] }),
      bundleLoader: (async (url: string) => ({ default: (register: ExtensionRegistrationHost) => {
        const extensionId = url.includes("/notes/") ? "notes" : "tasks";
        register.registerContextView({ id: "tab", title: extensionId, mount: () => ({ dispose: () => events.push(`dispose:${extensionId}`) }) });
      } })) as never,
    });
    await host.refresh();
    host.select("notes/tab");
    host.select("tasks/tab");
    notesEnabled = false;
    await host.refresh();
    expect(events).toEqual(["dispose:notes"]);
    expect(host.selectedId).toBe("tasks/tab");
    host.dispose();
    expect(events).toEqual(["dispose:notes", "dispose:tasks"]);
  });

  test("keeps a same-view document visibility link until its last listener releases", async () => {
    container = new FakeElement();
    let reads = 0;
    let release = () => {};
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async input => String(input).includes("/documents/")
        ? Response.json({ installationId, scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "notes", documentId: "one", revision: ++reads, document: {} })
        : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => {
        register.registerContextView({ id: "first", title: "First", mount: (_node, context) => { release = context.documents.subscribe("one", () => {}); context.documents.subscribe("one", () => {}); return { dispose() {} }; } });
        register.registerContextView({ id: "second", title: "Second", mount: () => ({ dispose() {} }) });
      } })) as never,
    });
    await host.refresh(); host.select("notes/first");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(reads).toBe(1);
    release(); host.select("notes/second");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(reads).toBe(1);
    host.select("notes/first");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(reads).toBe(2);
    host.dispose();
  });

  test("revokes a captured registration host after disable and accepts approved asset path characters", async () => {
    container = new FakeElement();
    let enabled = true; let lateHost: ExtensionRegistrationHost | undefined; let loads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/@theme/ui+theme.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/@theme/ui+theme.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => { loads++; return { default: (registration: ExtensionRegistrationHost) => { lateHost = registration; } }; }) as never,
    });
    await host.refresh(); expect(loads).toBe(1);
    enabled = false; await host.refresh();
    expect(() => lateHost!.registerContextView({ id: "late", title: "Late", mount: () => ({ dispose() {} }) })).toThrow("no longer active");
    expect(host.selectedId).toBeNull();
    host.dispose();
  });

  test("rejects a document read that completes after its selected scope is replaced", async () => {
    container = new FakeElement();
    let scope = "22222222-2222-4222-8222-222222222222";
    let finishDocument!: (response: Response) => void;
    let beganRead!: () => void;
    const documentResponse = new Promise<Response>(resolve => { finishDocument = resolve; });
    const readStarted = new Promise<void>(resolve => { beganRead = resolve; });
    let read: Promise<unknown> | undefined;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: scope }),
      authFetch: (input) => {
        return String(input).includes("/documents/")
          ? (beganRead(), documentResponse)
          : Promise.resolve(Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }));
      },
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "tab", title: "Notes", mount: (_container, context) => { read = context.documents.read("one"); return { dispose() {} }; } }) })) as never,
    });
    await host.refresh();
    host.select("notes/tab");
    expect(read).toBeDefined();
    await readStarted;
    scope = "33333333-3333-4333-8333-333333333333";
    await host.refresh();
    const outcome = read!.then(() => "resolved", error => error instanceof Error ? error.message : String(error));
    finishDocument(Response.json({ installationId, scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "notes", documentId: "one", revision: 1, document: { stale: true } }));
    expect(await outcome).toBe("stale extension scope");
    host.dispose();
  });

  test("drops a late bundle import after disable without disturbing another package", async () => {
    container = new FakeElement();
    let notesEnabled = true; let resolveNotes!: (value: { default: ExtensionRegistration }) => void; let notesStarted!: () => void;
    let notesSignal: AbortSignal | undefined;
    const lateNotes = new Promise<{ default: ExtensionRegistration }>(resolve => { resolveNotes = resolve; });
    const loadingNotes = new Promise<void>(resolve => { notesStarted = resolve; });
    const events: string[] = [];
    const installation = (id: string, enabled: boolean, digest: string) => ({ installationId, extensionId: id, enabled, package: { name: id, version: "1.0.0", digest }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/${id}/${digest}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" as const }, documents: [] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [installation("notes", notesEnabled, "a".repeat(64)), installation("tasks", true, "c".repeat(64))] }),
      bundleLoader: (async (url: string, _digest: string, options: { signal?: AbortSignal }) => { if (url.includes("/notes/")) { notesSignal = options.signal; notesStarted(); return lateNotes; } return { default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Tasks", mount: () => ({ dispose: () => events.push("dispose:tasks") }) }) }; }) as never,
    });
    const first = host.refresh();
    await loadingNotes;
    notesEnabled = false;
    await host.refresh();
    expect(notesSignal?.aborted).toBe(true);
    resolveNotes({ default: registration => registration.registerContextView({ id: "late", title: "Late", mount: () => ({ dispose: () => events.push("dispose:notes") }) }) });
    await first;
    host.select("notes/late");
    expect(host.selectedId).toBeNull();
    host.select("tasks/tab");
    expect(host.selectedId).toBe("tasks/tab");
    host.dispose();
    expect(events).toEqual(["dispose:tasks"]);
  });

  test("coalesces duplicate same-scope catalog acquisition but revalidates after it settles", async () => {
    container = new FakeElement();
    let calls = 0; let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => { calls++; return pending; },
    });
    try {
      const first = host.refresh(); await Promise.resolve();
      const duplicate = host.refresh();
      expect(calls).toBe(1);
      resolve(Response.json({ safeMode: false, installations: [] }));
      await Promise.all([first, duplicate]);
      await host.refresh();
      expect(calls).toBe(2);
    } finally { host.dispose(); }
  });

  test("aborts and disposes the old scope before a replacement catalog crosses an async boundary", async () => {
    container = new FakeElement();
    let scope = "22222222-2222-4222-8222-222222222222";
    let catalogCalls = 0;
    let resolveReplacement!: (response: Response) => void;
    const replacementCatalog = new Promise<Response>(resolve => { resolveReplacement = resolve; });
    const events: string[] = [];
    const catalog = () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: scope }),
      authFetch: async () => ++catalogCalls === 1 ? catalog() : replacementCatalog,
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, context) => {
        context.signal.addEventListener("abort", () => events.push("abort"));
        return { dispose: () => events.push("dispose") };
      } }) })) as never,
    });
    await host.refresh();
    host.select("notes/tab");
    scope = "33333333-3333-4333-8333-333333333333";
    const transition = host.refresh();
    await Promise.resolve();
    events.push("catalog-pending");
    resolveReplacement(catalog());
    await transition;
    expect(events.slice(0, 3)).toEqual(["abort", "dispose", "catalog-pending"]);
    host.dispose();
  });

  test("reloads changed, disabled, removed, and reinstalled packages without harming a peer", async () => {
    container = new FakeElement();
    let notesMode: "enabled" | "disabled" | "removed" = "enabled";
    let notesDigest = "a".repeat(64);
    const events: string[] = [];
    const loads: string[] = [];
    const installation = (extensionId: string, digest: string) => ({ installationId, extensionId, enabled: true, package: { name: extensionId, version: "1.0.0", digest }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/${extensionId}/${digest}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" as const }, documents: [] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => {
        const notes = installation("notes", notesDigest);
        return Response.json({ safeMode: false, installations: [
          ...(notesMode === "removed" ? [] : [{ ...notes, enabled: notesMode === "enabled" }]),
          installation("tasks", "c".repeat(64)),
        ] });
      },
      bundleLoader: (async (url: string) => {
        const extensionId = url.includes("/notes/") ? "notes" : "tasks";
        const digest = url.split("/")[5]!;
        loads.push(`${extensionId}:${digest[0]}`);
        return { default: (registration: ExtensionRegistrationHost) => {
          registration.registerContextView({ id: "tab", title: extensionId, mount: () => ({ dispose: () => events.push(`view:${extensionId}:${digest[0]}`) }) });
          return () => events.push(`package:${extensionId}:${digest[0]}`);
        } };
      }) as never,
    });
    await host.refresh();
    host.select("notes/tab");
    host.select("tasks/tab");
    notesDigest = "d".repeat(64);
    await host.refresh();
    expect(events.filter(event => event.includes("notes:a")).sort()).toEqual(["package:notes:a", "view:notes:a"]);
    expect(events.some(event => event.includes("tasks"))).toBe(false);
    host.select("notes/tab");
    notesMode = "disabled"; await host.refresh();
    notesMode = "enabled"; await host.refresh();
    notesMode = "removed"; await host.refresh();
    notesDigest = "e".repeat(64); notesMode = "enabled"; await host.refresh();
    expect(loads).toEqual(["notes:a", "tasks:c", "notes:d", "notes:d", "notes:e"]);
    expect(events.filter(event => event === "package:notes:d")).toHaveLength(2);
    host.dispose();
    expect(events.filter(event => event === "package:tasks:c")).toHaveLength(1);
    expect(events.filter(event => event === "package:notes:e")).toHaveLength(1);
  });

  test("rolls back partial registration despite throwing cleanup and keeps another package usable", async () => {
    container = new FakeElement();
    const events: string[] = [];
    const installation = (extensionId: string, digest: string) => ({ installationId, extensionId, enabled: true, package: { name: extensionId, version: "1.0.0", digest }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/${extensionId}/${digest}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" as const }, documents: [] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [installation("broken", "a".repeat(64)), installation("healthy", "c".repeat(64))] }),
      registerLayout: contribution => () => { events.push(`layout:${contribution.id}`); throw new Error("cleanup failed"); },
      bundleLoader: (async (url: string) => ({ default: (registration: ExtensionRegistrationHost) => {
        const extensionId = url.includes("/broken/") ? "broken" : "healthy";
        registration.registerContextView({ id: "tab", title: extensionId, mount: () => ({ dispose: () => events.push(`view:${extensionId}`) }) });
        if (extensionId === "broken") {
          registration.registerTerminalLayout({ id: "layout", title: "Broken layout", arrange: () => { throw new Error("unused"); } });
          throw new Error("registration failed");
        }
      } })) as never,
    });
    await host.refresh();
    expect(events).toEqual(["layout:broken/layout"]);
    host.select("broken/tab");
    expect(host.selectedId).toBeNull();
    host.select("healthy/tab");
    expect(host.selectedId).toBe("healthy/tab");
    host.dispose();
    expect(events).toContain("view:healthy");
  });

  test("rejects malformed, mismatched, and invalid-revision document envelopes", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const valid = { installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: 1, document: null };
    const cases: Array<readonly [string, () => Response]> = [
      ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
      ["mismatched identity", () => Response.json({ ...valid, documentId: "other" })],
      ["invalid revision", () => Response.json({ ...valid, revision: -1 })],
      ["missing document", () => Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: 1 })],
    ];
    for (const [label, response] of cases) {
      container = new FakeElement();
      let read: Promise<unknown> | undefined;
      const host = new ExtensionHost({
        container: container as unknown as HTMLElement,
        scope: () => ({ sessionId }),
        authFetch: async input => String(input).includes("/documents/")
          ? response()
          : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
        bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, context) => { read = context.documents.read("one"); return { dispose() {} }; } }) })) as never,
      });
      await host.refresh();
      host.select("notes/tab");
      expect(await read!.then(() => "resolved", error => (error as Error).message), label).toBe("extension document unavailable");
      expect(rightChrome("[data-extension-status]")?.textContent, label).toBe("Extension context data is unavailable.");
      host.dispose();
    }
  });

  test("rejects undeclared documents before a document request", async () => {
    container = new FakeElement();
    let documentRequests = 0;
    let read: Promise<unknown> | undefined;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async input => {
        if (String(input).includes("/documents/")) documentRequests++;
        return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] });
      },
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, context) => { read = context.documents.read("missing"); return { dispose() {} }; } }) })) as never,
    });
    await host.refresh();
    host.select("notes/tab");
    expect(await read!.then(() => "resolved", error => (error as Error).message)).toBe("extension document is not declared by this package");
    expect(documentRequests).toBe(0);
    host.dispose();
  });

  test("shows paused status for the selected document without replacing its mounted view", async () => {
    container = new FakeElement();
    let mountedNode: HTMLElement | undefined;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async input => String(input).includes("/documents/")
        ? Response.json({ installationId, scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "notes", documentId: "one", revision: 1, document: { safe: true } })
        : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (node, context) => { mountedNode = node; context.documents.subscribe("one", () => {}); return { dispose() {} }; } }) })) as never,
    });
    await host.refresh(); host.select("notes/tab"); await new Promise(resolve => setTimeout(resolve, 10));
    const originalNode = mountedNode;
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    (documentListeners.get("visibilitychange") as () => void)();
    expect(rightChrome("[data-extension-status]")?.textContent).toBe("Extension context updates are paused.");
    expect(mountedNode).toBe(originalNode);
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    (documentListeners.get("visibilitychange") as () => void)();
    host.dispose();
  });

  test("safe mode is inert before catalog, asset, or document requests", async () => {
    container = new FakeElement();
    const terminals = new FakeElement(), sessions = new FakeElement();
    let requests = 0;
    let safeMode = true;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      safeMode: () => safeMode,
      nativePanels: [{ id: ":terminals", title: "Terminal grid", element: terminals as unknown as HTMLElement }, { id: ":sessions", title: "Sessions", element: sessions as unknown as HTMLElement }],
      authFetch: async () => { requests++; throw new Error("must not fetch"); },
      bundleLoader: (async () => { requests++; throw new Error("must not load"); }) as never,
    });
    host.setNativePanels([":terminals", ":sessions"]);
    await host.refresh();
    host.moveWidget(":sessions", "main");
    expect(terminals.hidden).toBe(true);
    host.select(":terminals");
    expect(terminals.hidden).toBe(false);
    expect(rightChrome("[data-extension-status]")).toBeUndefined(); // Safe mode has no SDK dock.
    expect(requests).toBe(0);
    safeMode = false;
    host.dispose();
    await host.refresh();
    expect(requests).toBe(0);
  });

  test("registration is inert until user selection and scope replacement aborts/disposes the old mount", async () => {
    container = new FakeElement();
    let scope = "22222222-2222-4222-8222-222222222222";
    const events: string[] = [];
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: scope }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      bundleLoader: (async () => ({ default: (register: ExtensionRegistrationHost) => register.registerContextView({ id: "tab", title: "Notes", mount: (_container: HTMLElement, context: ExtensionViewContext) => { events.push(`mount:${context.scope.sessionId}`); context.signal.addEventListener("abort", () => events.push("abort")); return { dispose: () => events.push("dispose") }; } }) })) as never,
    });
    await host.refresh();
    expect(host.selectedId).toBeNull();
    expect(events).toEqual([]);
    host.select("notes/tab");
    expect(events).toEqual([`mount:${scope}`]);
    scope = "33333333-3333-4333-8333-333333333333";
    await host.refresh();
    expect(events).toEqual(["mount:22222222-2222-4222-8222-222222222222", "abort", "dispose"]);
    host.dispose();
  });

  test("preserves an installed extension layout selection across an ordinary exact-scope change", async () => {
    container = new FakeElement();
    const values = new Map<string, string>();
    const layouts = new TerminalLayoutRegistry({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
    let scope = "22222222-2222-4222-8222-222222222222";
    let enabled = true;
    let catalogAvailable = true;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: scope }),
      authFetch: async () => {
        if (!catalogAvailable) throw new Error("catalog unavailable");
        return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
      },
      registerLayout: contribution => layouts.register(contribution),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerTerminalLayout({ id: "recipe", title: "Recipe", arrange: equalGridLayout }) })) as never,
    });
    await host.refresh();
    layouts.select("notes/recipe");
    scope = "33333333-3333-4333-8333-333333333333";
    await host.refresh();
    expect(layouts.selectedId).toBe("notes/recipe");
    expect(values.get("wolfpack-terminal-layout")).toBe("notes/recipe");
    catalogAvailable = false;
    await host.refresh();
    expect(layouts.selectedId).toBe("notes/recipe");
    catalogAvailable = true;
    await host.refresh();
    enabled = false;
    await host.refresh();
    expect(layouts.selectedId).toBe("equal-grid");
    expect(values.get("wolfpack-terminal-layout")).toBe("equal-grid");
    host.dispose();
  });

  test("resumes a read-only mounted view after document hide and show", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let context: ExtensionViewContext | undefined;
    let reads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId }),
      authFetch: async input => String(input).includes("/documents/")
        ? Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: ++reads, document: { reads } })
        : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, value) => { context = value; return { dispose() {} }; } }) })) as never,
    });
    await host.refresh(); host.select("notes/tab");
    expect(await context!.documents.read("one")).toEqual({ reads: 1 });
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    (documentListeners.get("visibilitychange") as () => void)();
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    (documentListeners.get("visibilitychange") as () => void)();
    expect(await Promise.race([context!.documents.read("one"), new Promise(resolve => setTimeout(() => resolve("timeout"), 100))])).toEqual({ reads: 2 });
    host.dispose();
  });

  test("pauses an in-flight one-shot while the shell is hidden and catches it up after restore", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let context: ExtensionViewContext | undefined;
    let reads = 0;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId }),
      authFetch: async (input, init) => {
        if (!String(input).includes("/documents/")) return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] });
        reads++;
        if (reads === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: 1, document: { restored: true } });
      },
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, value) => { context = value; return { dispose() {} }; } }) })) as never,
    });
    await host.refresh(); host.select("notes/tab");
    const read = context!.documents.read("one");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(reads).toBe(1);
    host.setShellVisible(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    host.setShellVisible(true);
    expect(await read).toEqual({ restored: true });
    expect(reads).toBe(2);
    host.dispose();
  });

  test("does not let a released visible owner keep a hidden same-key subscriber polling", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let reads = 0;
    let releaseVisible = () => {};
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId }),
      authFetch: async input => String(input).includes("/documents/")
        ? Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: ++reads, document: { reads } })
        : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => {
        registration.registerContextView({ id: "first", title: "First", mount: (_node, context) => { releaseVisible = context.documents.subscribe("one", () => {}); return { dispose() {} }; } });
        registration.registerContextView({ id: "second", title: "Second", mount: (_node, context) => { context.documents.subscribe("one", () => {}); return { dispose() {} }; } });
      } })) as never,
    });
    await host.refresh(); host.select("notes/first"); await new Promise(resolve => setTimeout(resolve, 20));
    host.select("notes/second"); await new Promise(resolve => setTimeout(resolve, 20));
    host.select("notes/first"); await new Promise(resolve => setTimeout(resolve, 20));
    releaseVisible();
    const atRelease = reads;
    await new Promise(resolve => setTimeout(resolve, 2_200));
    expect(reads).toBe(atRelease);
    host.dispose();
  });

  test("rolls back a throwing initial subscription before retrying the failed view mount", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let firstMount = true;
    const values: unknown[] = [];
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId }),
      authFetch: async input => String(input).includes("/documents/")
        ? Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: 1, document: { answer: 42 } })
        : Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] }),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, context) => {
        const fails = firstMount; firstMount = false;
        context.documents.subscribe("one", value => { if (fails) throw new Error("initial listener failed"); if (value !== null) values.push(value); });
        return { dispose() {} };
      } }) })) as never,
    });
    await host.refresh(); host.select("notes/tab");
    expect(host.diagnostic).toContain("initial listener failed");
    host.select("notes/tab"); await new Promise(resolve => setTimeout(resolve, 50));
    expect(values).toEqual([{ answer: 42 }]);
    host.dispose();
  });

  test("host disposal preserves a selected installed recipe preference for reload", async () => {
    container = new FakeElement();
    const values = new Map<string, string>();
    const layouts = new TerminalLayoutRegistry({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] }),
      registerLayout: contribution => layouts.register(contribution),
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerTerminalLayout({ id: "recipe", title: "Recipe", arrange: equalGridLayout }) })) as never,
    });
    await host.refresh(); layouts.select("notes/recipe"); host.dispose();
    expect(values.get("wolfpack-terminal-layout")).toBe("notes/recipe");
  });

  test("keeps a coalesced one-shot reader alive when the last subscription releases", async () => {
    container = new FakeElement();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let context: ExtensionViewContext | undefined;
    let release = () => {};
    let resolveResponse!: (response: Response) => void;
    let reads = 0;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId }),
      authFetch: async input => {
        if (String(input).includes("/documents/")) { reads++; return response; }
        return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [{ id: "one", schemaVersion: 1 }] }] });
      },
      bundleLoader: (async () => ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Notes", mount: (_node, value) => { context = value; release = value.documents.subscribe("one", () => {}); return { dispose() {} }; } }) })) as never,
    });
    await host.refresh(); host.select("notes/tab");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    const read = context!.documents.read("one");
    release();
    resolveResponse(Response.json({ installationId, scopeSessionId: sessionId, extensionId: "notes", documentId: "one", revision: 1, document: { retained: true } }));
    expect(await read).toEqual({ retained: true });
    host.dispose();
  });
});
