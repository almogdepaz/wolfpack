import { afterAll, expect, test } from "bun:test";

const originals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
const storage = new Map<string, string>();
const controls = new Map<string, any>();
for (const id of ["setting-notifications", "notification-setting-status", "notification-prompt", "notification-prompt-message", "notification-prompt-enable", "notification-prompt-dismiss", "notification-test"]) {
  controls.set(id, { hidden: false, dataset: {}, textContent: "", type: "checkbox", addEventListener() {} });
}
const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
let permission = "default", permissionCalls = 0, registrations = 0;
global("localStorage", localStorage);
global("sessionStorage", localStorage);
global("location", { origin: "http://localhost", href: "http://localhost/" });
global("window", { innerWidth: 1000, Notification: {}, PushManager: {}, addEventListener() {}, matchMedia: () => ({ matches: false }) });
global("document", { getElementById: (id: string) => controls.get(id) ?? null, addEventListener() {}, querySelectorAll: () => [], body: { classList: { toggle() {}, add() {}, remove() {} } } });
global("Notification", { get permission() { return permission; }, requestPermission: async () => { permissionCalls++; return "granted"; } });
const subscription = { endpoint: "https://fcm.googleapis.com/test", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test" }) };
const registration = { pushManager: { subscribe: async () => subscription, getSubscription: async () => subscription } };
global("navigator", { userAgent: "Chromium", maxTouchPoints: 0, serviceWorker: { register: async () => { registrations++; return registration; }, ready: Promise.resolve(registration), getRegistration: async () => registration } });
const requests: string[] = [];
global("fetch", async (url: string) => { requests.push(url); return Response.json(url.endsWith("vapid-key") ? { publicKey: "AQ" } : { ok: true, sent: 1, failed: 0 }); });
// Browser sources have their own tsconfig; use the established browser harness import.
const app = await import(new URL("../../public/app-state.ts", import.meta.url).href) as {
  wpSettings: { notifications: boolean };
  state: { notificationsEnabled: boolean };
  initSettings(): void;
  syncNotificationsPermission(): void;
  sendTestNotification(): Promise<void>;
};
afterAll(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test("startup never requests permission or unsubscribes an off preference", async () => {
  app.wpSettings.notifications = true;
  app.initSettings();
  await settle();
  expect(permissionCalls).toBe(0);
  expect(app.wpSettings.notifications).toBe(false);
  requests.length = 0;
  app.initSettings();
  await settle();
  expect(requests).toEqual([]);
});

test("granted stored preference silently re-registers and exposes test delivery", async () => {
  permission = "granted";
  app.wpSettings.notifications = true;
  app.initSettings();
  await settle();
  expect(registrations).toBeGreaterThan(0);
  expect(controls.get("notification-test").hidden).toBe(false);
  expect(controls.get("notification-setting-status").textContent).toContain("all online machines");
});

test("test button reports delivery on the current origin only", async () => {
  requests.length = 0;
  await app.sendTestNotification();
  expect(requests).toEqual(["http://localhost/api/push/test"]);
  expect(controls.get("notification-setting-status").textContent).toBe("Test notification sent.");
  expect(controls.get("notification-test").disabled).toBe(false);
});

test("prompt visibility follows permission, preference, dismissal and ios home-screen requirement", () => {
  app.state.notificationsEnabled = false;
  permission = "default";
  app.wpSettings.notifications = false;
  app.syncNotificationsPermission();
  expect(controls.get("notification-prompt").hidden).toBe(false);
  storage.set("wp-notification-prompt-dismissed", "1");
  app.syncNotificationsPermission();
  expect(controls.get("notification-prompt").hidden).toBe(true);
  storage.delete("wp-notification-prompt-dismissed");
  Reflect.deleteProperty(window, "PushManager");
  Object.assign(navigator, { userAgent: "iPhone", standalone: false });
  app.syncNotificationsPermission();
  expect(controls.get("notification-prompt-message").textContent).toContain("home screen");
  expect(controls.get("notification-setting-status").textContent).toContain("home screen");
  Object.assign(window, { PushManager: {} });
  permission = "denied";
  app.syncNotificationsPermission();
  expect(controls.get("notification-setting-status").textContent).toContain("Settings app → Notifications → Wolfpack");
  expect(controls.get("notification-prompt").hidden).toBe(true);
});
