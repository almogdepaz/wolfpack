import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHost } from "../../public/extension-host.ts";
import { TerminalLayoutRegistry } from "../../public/terminal-layout-registry.ts";
import { equalGridLayout } from "../../src/extensions/layout-contract.ts";
import { WidgetLayout } from "../../public/widget-layout.ts";
import type { ExtensionRegistration, ExtensionRegistrationHost, ExtensionViewContext } from "../../src/extensions/sdk.ts";

class FakeElement {
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
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener() {}
  querySelector<T extends FakeElement>(selector: string): T | null {
    const name = selector.match(/^\[data-([^\]]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return (name ? this.children.find(child => name in child.dataset) ?? this.children.map(child => child.querySelector<T>(selector)).find(Boolean) : undefined) as T ?? null;
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
function rightChrome(selector: string): FakeElement | undefined {
  return container.children.filter(child => child.dataset.widgetArea === "right").map(child => child.querySelector(selector)).find((child): child is FakeElement => !!child);
}
afterEach(() => {
  container?.remove();
  documentListeners.clear();
  (document as unknown as { visibilityState: string }).visibilityState = "visible";
});

describe("ExtensionHost", () => {
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
      host.moveWidget(":terminals", "bottom");
      expect(terminals.hidden).toBe(false); expect(terminals.dataset.widgetArea).toBe("bottom");
      const preferences = saved;
      host.setPresentation({ visible: false, desktop: true, focusArea: null });
      expect(terminals.dataset.widgetArea).toBe("main"); expect(visible).toBe(false); expect(saved).toBe(preferences);
      host.select("widgets/view-30"); expect(mounts).toBe(1); // hidden widget actions cannot mount code
      host.setPresentation({ visible: true, desktop: true, focusArea: null }); host.select();
      expect(terminals.dataset.widgetArea).toBe("bottom"); expect(visible).toBe(true);
      expect(terminals.parentElement).toBe(parent); expect(sessions.parentElement).toBe(parent);
      expect(mounts).toBe(1); expect(disposals).toBe(0);
      host.select(":unknown"); expect(host.diagnostic).toContain("unavailable");
    } finally { host.dispose(); }
    expect(disposals).toBe(1);
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

  test("host opt-in opens the sole view without a tab, while multiple views keep their selector", async () => {
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
    expect(host.selectedId).toBe("view0/context"); expect(mounts).toBe(1); expect(tabs().hidden).toBe(true);
    host.select(); expect(mounts).toBe(1);
    count = 2; await host.refresh(); host.select();
    expect(tabs().hidden).toBe(false); expect(host.selectedId).toBe("view0/context");
    host.select("view1/context"); expect(mounts).toBe(2);
    count = 1; await host.refresh(); host.select();
    expect(host.selectedId).toBe("view0/context"); expect(tabs().hidden).toBe(true);
    count = 0; await host.refresh(); host.select();
    expect(host.selectedId).toBeNull(); expect(tabs().hidden).toBe(true);
    count = 1; failMount = true; await host.refresh(); host.select();
    expect(host.selectedId).toBeNull(); expect(tabs().hidden).toBe(false);
    expect(host.diagnostic).toContain("broken view");
    failMount = false; host.select("view0/context");
    expect(tabs().hidden).toBe(true);
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
    expect(rightChrome("[data-extension-status]")?.textContent).toContain("catalog unavailable");
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
