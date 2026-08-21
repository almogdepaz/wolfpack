import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  compareCanonicalJsonKeysByLocale,
} from "../../src/canonical-json.ts";

describe("canonical JSON", () => {
  test("sorts recursive object keys by code unit and omits undefined object properties", () => {
    expect(canonicalJson({
      z: { z: 1, a: 2, omitted: undefined },
      a: true,
      A: null,
      "!": "punctuation",
    })).toBe("{\"!\":\"punctuation\",\"A\":null,\"a\":true,\"z\":{\"a\":2,\"z\":1}}");
  });

  test("propagates a deterministic injected comparator through nested objects", () => {
    const descendingCodeUnit = (left: string, right: string): number => left < right ? 1 : left > right ? -1 : 0;
    const value = { a: { a: 1, c: 3, b: 2 }, c: 3, b: 2 };

    expect(canonicalJson(value)).toBe("{\"a\":{\"a\":1,\"b\":2,\"c\":3},\"b\":2,\"c\":3}");
    expect(canonicalJson(value, descendingCodeUnit))
      .toBe("{\"c\":3,\"b\":2,\"a\":{\"c\":3,\"b\":2,\"a\":1}}");
  });

  test("delegates locale ordering to the runtime-native localeCompare behavior", () => {
    const value: Readonly<Record<string, number>> = { z: 1, Z: 2, a: 3, A: 4, "!": 5, _: 6 };
    const runtimeSortedKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
    const runtimeExpected = JSON.stringify(Object.fromEntries(
      runtimeSortedKeys.map((key) => [key, value[key]]),
    ));

    expect(compareCanonicalJsonKeysByLocale("_", "!")).toBe("_".localeCompare("!"));
    expect(canonicalJson(value, compareCanonicalJsonKeysByLocale)).toBe(runtimeExpected);
  });

  test("retains array order and sparse-array serialization", () => {
    const sparse = new Array<unknown>(3);
    sparse[1] = { z: 1, a: 2 };

    expect(canonicalJson(["last", "first", sparse])).toBe("[\"last\",\"first\",[null,{\"a\":2,\"z\":1},null]]");
  });

  test.each([null, true, false, "text", 0, -1.5] as const)("accepts JSON primitive %p", (value) => {
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %p",
    (value) => {
      expect(() => canonicalJson(value)).toThrow("non-finite");
    },
  );

  test.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("unsupported")],
  ] as const)("rejects explicit unsupported %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => canonicalJson([value])).toThrow(TypeError);
  });

  test("does not invoke toJSON", () => {
    let invoked = false;
    const value = { nested: true };
    Object.defineProperty(value, "toJSON", {
      enumerable: false,
      value: () => {
        invoked = true;
        return { replaced: true };
      },
    });

    expect(canonicalJson(value)).toBe("{\"nested\":true}");
    expect(invoked).toBe(false);
  });
});
