import { afterEach, beforeEach, expect, test } from "bun:test";
import { authenticatedFetchWithTimeout, getBrowserAuthToken } from "../../public/browser-auth.ts";

// Exercise the default production credential dialog, not an injected prompt.
class Element extends EventTarget {
  textContent = ""; hidden = false; value = ""; name = "";
  children: Element[] = [];
  classList = { toggle() {} };
  replaceChildren() { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  querySelectorAll(): Element[] { return this.children.flatMap(child => child.name ? [child] : child.querySelectorAll()); }
  querySelector() { return this.querySelectorAll()[0] ?? null; }
  focus() {} setCustomValidity() {} reportValidity() { return true; }
}
class Form extends Element {}
class Button extends Element {}
class Dialog extends Element {
  open = false; returnValue = ""; opens = 0;
  showModal() { if (this.open) throw new Error("busy"); this.open = true; this.opens++; }
  close(value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new Event("close")); }
}
const saved = new Map<string, PropertyDescriptor | undefined>();
let dialog: Dialog, fields: Element, form: Form, message: Element;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  dialog = new Dialog(); fields = new Element(); form = new Form(); message = new Element();
  const elements: Record<string, Element> = { "app-dialog": dialog, "app-dialog-form": form,
    "app-dialog-title": new Element(), "app-dialog-message": message, "app-dialog-fields": fields,
    "app-dialog-cancel": new Button(), "app-dialog-confirm": new Button() };
  const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) }; };
  const globals: Record<string, unknown> = {
    location: new URL("https://local.test/app"), sessionStorage: storage(), localStorage: storage(),
    HTMLElement: Element, HTMLDialogElement: Dialog, HTMLFormElement: Form, HTMLButtonElement: Button,
    document: { activeElement: null, getElementById: (id: string) => elements[id], createElement: () => new Element() },
    FormData: class { entries() { return fields.querySelectorAll().map(input => [input.name, input.value] as const)[Symbol.iterator](); } },
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  if (dialog.open) dialog.close("cancel");
  await settle();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});
function accept(token: string) {
  fields.querySelector()!.value = token;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
function request(origin = "https://local.test", signal?: AbortSignal) {
  return authenticatedFetchWithTimeout(`${origin}/api/settings`, { signal }, {
    timedFetch: async input => new Response(null, { status: getBrowserAuthToken(input) ? 200 : 401 }),
  });
}

test("concurrent same-origin interactive callers share one default dialog and retry", async () => {
  const first = request();
  const second = request().then(response => response.status, error => String(error));
  await settle();
  expect(dialog.opens).toBe(1);
  accept("local-token");
  expect((await first).status).toBe(200);
  expect(await second).toBe(200);
});

test("one cancelled shared owner does not close the remaining owner's dialog", async () => {
  const owner = new AbortController();
  const first = request(undefined, owner.signal).catch(error => error.message);
  const second = request().then(response => response.status, error => String(error));
  await settle();
  owner.abort(new DOMException("owner retired", "AbortError"));
  expect(await first).toBe("owner retired");
  expect(dialog.open).toBe(true);
  accept("remaining-token");
  expect(await second).toBe(200);
});

test("distinct origins serialize dialogs without sharing credentials", async () => {
  const first = request();
  const second = request("https://peer.test").then(response => response.status, error => String(error));
  await settle();
  expect(message.textContent).toContain("https://local.test");
  accept("local-token");
  expect((await first).status).toBe(200);
  await settle();
  expect(dialog.open).toBe(true);
  expect(message.textContent).toContain("https://peer.test");
  expect(getBrowserAuthToken("https://peer.test/api/settings")).toBeNull();
  accept("peer-token");
  expect(await second).toBe(200);
  expect(getBrowserAuthToken("/api/settings")).toBe("local-token");
  expect(getBrowserAuthToken("https://peer.test/api/settings")).toBe("peer-token");
});

test("last active owner cancellation closes its dialog without poisoning a subsequent same-origin owner", async () => {
  const owner = new AbortController();
  const retired = request(undefined, owner.signal).catch(error => error.message);
  await settle();
  expect(dialog.open).toBe(true);
  owner.abort(new DOMException("last owner retired", "AbortError"));
  expect(await retired).toBe("last owner retired");
  expect(dialog.open).toBe(false);
  const next = request();
  await settle();
  expect(dialog.opens).toBe(2);
  accept("next-owner-token");
  expect((await next).status).toBe(200);
});

test("cancelled queued owners never acquire a credential dialog", async () => {
  const first = request();
  const queued = new AbortController();
  const second = request("https://peer.test", queued.signal).then(response => response.status, error => error.message);
  await settle();
  queued.abort(new DOMException("queued retired", "AbortError"));
  expect(await second).toBe("queued retired");
  accept("local-token");
  await first;
  await settle();
  expect(dialog.opens).toBe(1);
  expect(dialog.open).toBe(false);
  expect(getBrowserAuthToken("https://peer.test/api/settings")).toBeNull();
});
