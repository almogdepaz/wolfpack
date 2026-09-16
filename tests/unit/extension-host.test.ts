import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHost } from "../../public/extension-host.ts";
import type { ExtensionRegistration, ExtensionRegistrationHost, ExtensionViewContext } from "../../src/extensions/sdk.ts";

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = "";
  hidden = false;
  type = "";
  private readonly attributes = new Map<string, string>();
  append(child: FakeElement) { child.parentElement = this; this.children.push(child); }
  prepend(child: FakeElement) { child.parentElement = this; this.children.unshift(child); }
  remove() { if (!this.parentElement) return; const at = this.parentElement.children.indexOf(this); if (at >= 0) this.parentElement.children.splice(at, 1); this.parentElement = null; }
  replaceChildren() { for (const child of this.children) child.parentElement = null; this.children.length = 0; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener() {}
  querySelector<T extends FakeElement>(selector: string): T | null {
    const name = selector.match(/^\[data-([^\]]+)\]$/)?.[1];
    return (name ? this.children.find(child => name in child.dataset) : undefined) as T ?? null;
  }
}

const documentListeners = new Map<string, unknown>();
(globalThis as Record<string, unknown>).document = {
  visibilityState: "visible",
  createElement: () => new FakeElement(),
  addEventListener: (name: string, listener: unknown) => documentListeners.set(name, listener),
  removeEventListener: (name: string) => documentListeners.delete(name),
};

const installationId = "11111111-1111-4111-8111-111111111111";
let container: FakeElement;
afterEach(() => {
  container?.remove();
  documentListeners.clear();
  (document as unknown as { visibilityState: string }).visibilityState = "visible";
});

describe("ExtensionHost", () => {
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
    host.select("notes/first");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(documentReads).toBe(1);
    host.select("notes/second");
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
    expect(container.children.find(child => "extensionStatus" in child.dataset)?.textContent).toContain("catalog unavailable");
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
    let notesEnabled = true; let resolveNotes!: (value: { default: ExtensionRegistration }) => void;
    const lateNotes = new Promise<{ default: ExtensionRegistration }>(resolve => { resolveNotes = resolve; });
    const events: string[] = [];
    const installation = (id: string, enabled: boolean, digest: string) => ({ installationId, extensionId: id, enabled, package: { name: id, version: "1.0.0", digest }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/${id}/${digest}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" as const }, documents: [] });
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      authFetch: async () => Response.json({ safeMode: false, installations: [installation("notes", notesEnabled, "a".repeat(64)), installation("tasks", true, "c".repeat(64))] }),
      bundleLoader: (async (url: string) => url.includes("/notes/") ? lateNotes : ({ default: (registration: ExtensionRegistrationHost) => registration.registerContextView({ id: "tab", title: "Tasks", mount: () => ({ dispose: () => events.push("dispose:tasks") }) }) })) as never,
    });
    const first = host.refresh();
    await Promise.resolve();
    notesEnabled = false;
    await host.refresh();
    resolveNotes({ default: registration => registration.registerContextView({ id: "late", title: "Late", mount: () => ({ dispose: () => events.push("dispose:notes") }) }) });
    await first;
    host.select("notes/late");
    expect(host.selectedId).toBeNull();
    host.select("tasks/tab");
    expect(host.selectedId).toBe("tasks/tab");
    host.dispose();
    expect(events).toEqual(["dispose:tasks"]);
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
      expect(container.children.find(child => "extensionStatus" in child.dataset)?.textContent, label).toBe("Extension context data is unavailable.");
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
    expect(container.children.find(child => "extensionStatus" in child.dataset)?.textContent).toBe("Extension context updates are paused.");
    expect(mountedNode).toBe(originalNode);
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    (documentListeners.get("visibilitychange") as () => void)();
    host.dispose();
  });

  test("safe mode is inert before catalog, asset, or document requests", async () => {
    container = new FakeElement();
    let requests = 0;
    let safeMode = true;
    const host = new ExtensionHost({
      container: container as unknown as HTMLElement,
      scope: () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      safeMode: () => safeMode,
      authFetch: async () => { requests++; throw new Error("must not fetch"); },
      bundleLoader: (async () => { requests++; throw new Error("must not load"); }) as never,
    });
    await host.refresh();
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
});
