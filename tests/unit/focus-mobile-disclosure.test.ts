import { expect, test } from "bun:test";
import { createFocusMobileDisclosure, FOCUS_MOBILE_EXPANDED_KEY } from "../../public/focus-mobile-disclosure";
test("attention supplies the default, while an explicit device preference wins", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const view = createFocusMobileDisclosure(() => storage);
  expect(view.expanded(false)).toBe(false);
  expect(view.expanded(true)).toBe(true);
  view.toggle(true);
  expect(view.expanded(true)).toBe(false);
  expect(createFocusMobileDisclosure(() => storage).expanded(true)).toBe(false);
  view.toggle(true);
  expect(createFocusMobileDisclosure(() => storage).expanded(false)).toBe(true);
  expect(values.get(FOCUS_MOBILE_EXPANDED_KEY)).toBe("1");
});
test("desktop defaults expanded and stores a preference independent of mobile attention", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const options = { key: "wolfpack-focus-desktop-expanded-v1", defaultExpanded: true };
  const desktop = createFocusMobileDisclosure(() => storage, options);
  const mobile = createFocusMobileDisclosure(() => storage);
  expect(desktop.expanded(false)).toBe(true);
  desktop.toggle(false);
  expect(desktop.expanded(true)).toBe(false);
  expect(mobile.expanded(false)).toBe(false);
  expect(mobile.expanded(true)).toBe(true);
  mobile.toggle(false);
  expect(mobile.expanded(false)).toBe(true);
  expect(createFocusMobileDisclosure(() => storage, options).expanded(true)).toBe(false);
  expect(values.get(options.key)).toBe("0");
  expect(values.get(FOCUS_MOBILE_EXPANDED_KEY)).toBe("1");
});
test("desktop malformed/denied storage keeps its expanded default and in-memory override", () => {
  for (const storage of [() => ({ getItem: () => "invalid", setItem: () => { throw new Error("quota"); } }), () => { throw new Error("denied"); }]) {
    const desktop = createFocusMobileDisclosure(storage, { key: "wolfpack-focus-desktop-expanded-v1", defaultExpanded: true });
    expect(desktop.expanded(false)).toBe(true);
    desktop.toggle(false);
    expect(desktop.expanded(true)).toBe(false);
  }
});
test("missing/malformed or throwing storage still renders and keeps an in-memory choice", () => {
  for (const value of [null, "garbage"]) {
    const view = createFocusMobileDisclosure(() => ({ getItem: () => value, setItem: () => { throw new Error("quota"); } }));
    expect(view.expanded(false)).toBe(false); view.toggle(false); expect(view.expanded(false)).toBe(true);
  }
  const blocked = createFocusMobileDisclosure(() => { throw new Error("storage denied"); });
  expect(blocked.expanded(true)).toBe(true); blocked.toggle(true); expect(blocked.expanded(true)).toBe(false);
});
