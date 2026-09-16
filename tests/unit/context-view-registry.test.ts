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
