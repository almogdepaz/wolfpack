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
test("missing/malformed or throwing storage still renders and keeps an in-memory choice", () => {
  for (const value of [null, "garbage"]) {
    const view = createFocusMobileDisclosure(() => ({ getItem: () => value, setItem: () => { throw new Error("quota"); } }));
    expect(view.expanded(false)).toBe(false); view.toggle(false); expect(view.expanded(false)).toBe(true);
  }
  const blocked = createFocusMobileDisclosure(() => { throw new Error("storage denied"); });
  expect(blocked.expanded(true)).toBe(true); blocked.toggle(true); expect(blocked.expanded(true)).toBe(false);
});
