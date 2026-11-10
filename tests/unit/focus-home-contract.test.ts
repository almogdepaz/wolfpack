import { expect, test } from "bun:test";
import { isFocusHome, isFocusHomeIdentity } from "../../src/focus-home-contract";
test("focus identity metadata requires valid ids and a consistent local flag", () => {
  expect(isFocusHomeIdentity({ home: "self", installationId: "self", local: true, error: "store unreadable" })).toBe(true);
  expect(isFocusHomeIdentity({ home: "peer", installationId: "self", local: false })).toBe(true);
  for (const value of [null, [], {}, { error: "only a diagnostic" }, { home: "self", installationId: "self", local: false }, { home: "peer", installationId: "self", local: true }, { home: null, installationId: "self", local: false }, { home: "bad id", installationId: "self", local: false }, { home: "peer", installationId: "", local: false }]) expect(isFocusHomeIdentity(value)).toBe(false);
  expect(isFocusHome(null)).toBe(true);
  expect(isFocusHome("valid-id_1")).toBe(true);
  for (const value of [undefined, false, {}, "", "bad id", "x".repeat(129)]) expect(isFocusHome(value)).toBe(false);
});
