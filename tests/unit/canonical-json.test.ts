import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../src/canonical-json.ts";

describe("canonical JSON", () => {
  test("sorts recursive object keys by code unit and omits undefined object properties", () => {
    expect(canonicalJson({
      z: { z: 1, a: 2, omitted: undefined },
      a: true,
      A: null,
      "!": "punctuation",
    })).toBe("{\"!\":\"punctuation\",\"A\":null,\"a\":true,\"z\":{\"a\":2,\"z\":1}}");
  });

  test("uses utf-16 code-unit ordering across punctuation and case-sensitive keys", () => {
    const value = { _: 1, "!": 2, a: 3, A: 4, nested: { _: 5, "!": 6, a: 7, A: 8 } };

    expect(canonicalJson(value))
      .toBe("{\"!\":2,\"A\":4,\"_\":1,\"a\":3,\"nested\":{\"!\":6,\"A\":8,\"_\":5,\"a\":7}}");
  });

  test("orders numeric-looking keys by utf-16 code unit rather than object enumeration", () => {
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe("{\"10\":\"ten\",\"2\":\"two\"}");
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
