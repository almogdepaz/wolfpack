import { expect, test } from "bun:test";
import { WidgetVisibility } from "../../public/widget-visibility.ts";

test("widget visibility persists by installation and extension, not package version or session", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const first = new WidgetVisibility(storage);
  const identity = { installationId: "installation-one", extensionId: "one" };
  expect(first.isVisible(identity)).toBe(true);
  let changes = 0;
  const unsubscribe = first.subscribe(() => { changes++; });
  first.setVisible(identity, false);
  expect(changes).toBe(1);
  const reloaded = new WidgetVisibility(storage);
  expect(reloaded.isVisible(identity)).toBe(false);
  expect(reloaded.isVisible({ ...identity, extensionId: "two" })).toBe(true);
  expect(reloaded.isVisible({ ...identity, installationId: "installation-two" })).toBe(true);
  unsubscribe(); first.setVisible(identity, true);
  expect(changes).toBe(1); expect(reloaded.isVisible(identity)).toBe(true);
  first.changed(); expect(changes).toBe(1);
});

test("failed storage writes do not notify a saved change; corrupt or inaccessible values default visible", () => {
  const identity = { installationId: "installation-one", extensionId: "one" };
  const storage = { getItem: () => "not-a-preference", setItem: () => { throw Error("blocked"); } };
  const visibility = new WidgetVisibility(storage);
  let changes = 0;
  visibility.subscribe(() => { changes++; });
  expect(visibility.isVisible(identity)).toBe(true);
  expect(() => visibility.setVisible(identity, false)).toThrow("blocked");
  expect(changes).toBe(0);
  storage.getItem = () => { throw Error("blocked"); };
  expect(visibility.isVisible(identity)).toBe(true);
});
