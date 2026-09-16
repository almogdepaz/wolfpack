import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionHost } from "../../public/extension-host.ts";
import type { ExtensionRegistrationHost, ExtensionViewContext } from "../../src/extensions/sdk.ts";

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
afterEach(() => { container?.remove(); documentListeners.clear(); });

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
        return Response.json({ safeMode: false, installations: [{ installationId, extensionId: "notes", enabled: true, package: { name: "notes", version: "1.0.0", digest: "a".repeat(64) }, ui: { path: "dist/ui.js", url: `/api/extensions/assets/notes/${"a".repeat(64)}/dist/ui.js`, digest: "b".repeat(64), mime: "text/javascript" }, documents: [] }] });
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
