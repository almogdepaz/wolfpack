import { afterEach, describe, expect, test } from "bun:test";
import { ContextViewRegistry } from "../../public/context-view-registry.ts";

const scope = { installationId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" } as const;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  hidden = false;
  textContent = "";
  parent: FakeElement | null = null;
  append(child: FakeElement) { child.parent = this; this.children.push(child); }
  remove() { if (!this.parent) return; const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); this.parent = null; }
}

(globalThis as Record<string, unknown>).document = { createElement: () => new FakeElement() };

function view(id: string, events: string[] = []) {
  return {
    id,
    title: id,
    mount(container: HTMLElement, context: { readonly signal: AbortSignal }) {
      events.push(`mount:${id}`);
      container.textContent = id;
      context.signal.addEventListener("abort", () => events.push(`abort:${id}`));
      return { dispose: () => events.push(`dispose:${id}`), setVisible: (visible: boolean) => events.push(`visible:${id}:${visible}`) };
    },
  };
}

describe("ContextViewRegistry", () => {
  let container: FakeElement;
  afterEach(() => container?.remove());

  test("does not mount newly registered views until explicit selection and retains visited views hidden", () => {
    container = new FakeElement();
    const events: string[] = [];
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement, maxRetainedViews: 2 });
    registry.register("notes/one", view("one", events));
    registry.register("context/two", view("two", events));
    registry.setScope(scope);
    expect(events).toEqual([]);
    registry.select("notes/one");
    registry.select("context/two");
    expect(events).toEqual(["mount:one", "visible:one:true", "mount:two", "visible:one:false", "visible:two:true"]);
    expect(container.children).toHaveLength(2);
    expect(registry.selectedId).toBe("context/two");
  });

  test("disposes exactly once before replacement scope and rejects retained-view overflow visibly", () => {
    container = new FakeElement();
    const events: string[] = [];
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement, maxRetainedViews: 1 });
    registry.register("notes/one", view("one", events));
    registry.register("notes/two", view("two", events));
    registry.setScope(scope);
    registry.select("notes/one");
    registry.select("notes/two");
    expect(registry.diagnostic).toContain("retained view limit");
    registry.setScope({ ...scope, sessionId: "33333333-3333-4333-8333-333333333333" });
    expect(events.filter(event => event === "dispose:one")).toHaveLength(1);
    expect(events.filter(event => event === "abort:one")).toHaveLength(1);
  });

  test("keeps bounded visibility diagnostics and lets another view recover", () => {
    container = new FakeElement();
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement });
    registry.register("broken/tab", {
      id: "tab",
      title: "Broken",
      mount: () => ({ dispose() {}, setVisible: () => { throw new Error("package detail must not leak"); } }),
    });
    registry.register("healthy/tab", view("healthy"));
    registry.setScope(scope);
    registry.select("broken/tab");
    expect(registry.diagnostic).toBe("Visibility update failed for broken/tab.");
    registry.select("healthy/tab");
    expect(registry.selectedId).toBe("healthy/tab");
    expect(registry.diagnostic).toBe("");
  });

  test("retains exactly 32 visited views without eviction and visibly rejects the 33rd", () => {
    container = new FakeElement();
    const events: string[] = [];
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement, maxRetainedViews: 99 });
    for (let index = 0; index < 33; index++) registry.register(`notes/${index}`, view(String(index), events));
    registry.setScope(scope);
    for (let index = 0; index < 32; index++) registry.select(`notes/${index}`);
    const firstNode = container.children[0];
    registry.select("notes/32");
    expect(container.children).toHaveLength(32);
    expect(container.children[0]).toBe(firstNode);
    expect(events).not.toContain("dispose:0");
    expect(registry.selectedId).toBe("notes/31");
    expect(registry.diagnostic).toContain("retained view limit (32) reached");
  });

  test("contains mount and dispose failures while another registered view remains usable", () => {
    container = new FakeElement();
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement });
    registry.register("broken/mount", { id: "mount", title: "Mount failure", mount: () => { throw new Error("bounded package failure"); } });
    const removeCleanupFailure = registry.register("broken/cleanup", { id: "cleanup", title: "Cleanup failure", mount: () => ({ dispose: () => { throw new Error("cleanup failure"); } }) });
    registry.register("healthy/tab", view("healthy"));
    registry.setScope(scope);
    registry.select("broken/mount");
    expect(registry.diagnostic).toContain("Could not mount Mount failure: bounded package failure");
    registry.select("broken/cleanup");
    removeCleanupFailure();
    expect(registry.diagnostic).toBe("Cleanup failed for broken/cleanup.");
    registry.select("healthy/tab");
    expect(registry.selectedId).toBe("healthy/tab");
    expect(registry.diagnostic).toBe("");
  });

  test("unregister cleans only its mounted contribution and leaves another package intact", () => {
    container = new FakeElement();
    const events: string[] = [];
    const registry = new ContextViewRegistry({ container: container as unknown as HTMLElement });
    const removeOne = registry.register("notes/one", view("one", events));
    registry.register("context/two", view("two", events));
    registry.setScope(scope);
    registry.select("notes/one");
    registry.select("context/two");
    removeOne();
    expect(events.filter(event => event === "dispose:one")).toHaveLength(1);
    expect(registry.entries().map(entry => entry.id)).toEqual(["context/two"]);
  });
});
