import { describe, expect, test } from "bun:test";
import {
  brokerOutputAdvanced,
  brokerOutputSequence,
} from "../../src/broker-output-sequence";

describe("broker output sequence", () => {
  test("accepts canonical decimal u64 values only", () => {
    expect(brokerOutputSequence("0")).toBe("0");
    expect(brokerOutputSequence("18446744073709551615")).toBe("18446744073709551615");
    expect(brokerOutputSequence("01")).toBeUndefined();
    expect(brokerOutputSequence("18446744073709551616")).toBeUndefined();
    expect(brokerOutputSequence(42)).toBeUndefined();
  });

  test("reports activity only when a known sequence advances", () => {
    expect(brokerOutputAdvanced(undefined, "1")).toBe(false);
    expect(brokerOutputAdvanced("1", undefined)).toBe(false);
    expect(brokerOutputAdvanced("1", "1")).toBe(false);
    expect(brokerOutputAdvanced("2", "1")).toBe(false);
    expect(brokerOutputAdvanced("1", "2")).toBe(true);
  });
});
