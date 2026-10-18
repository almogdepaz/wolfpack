import { describe, expect, test } from "bun:test";
import { BROKER_PROTOCOL_VERSION, classifyBrokerHello } from "../../src/broker/hello.ts";

describe("classifyBrokerHello", () => {
  test("accepts a hello for this protocol version", () => {
    expect(classifyBrokerHello({ status: "ok", payload: { kind: "hello", protocol_version: BROKER_PROTOCOL_VERSION, broker_version: "1.6.26" } }))
      .toEqual({ kind: "compatible", protocolVersion: BROKER_PROTOCOL_VERSION, brokerVersion: "1.6.26" });
  });

  test("flags a different protocol version as incompatible", () => {
    expect(classifyBrokerHello({ status: "ok", payload: { kind: "hello", protocol_version: 3, broker_version: "9.0.0" } }))
      .toEqual({ kind: "incompatible", protocolVersion: 3, brokerVersion: "9.0.0" });
  });

  test("treats unknown_method as a broker that predates hello", () => {
    expect(classifyBrokerHello({ status: "error", error: { code: "unknown_method", message: "unknown method: hello" } }))
      .toEqual({ kind: "pre_hello" });
  });

  test("reports other errors and malformed payloads", () => {
    expect(classifyBrokerHello({ status: "error", error: { code: "internal_error", message: "boom" } }))
      .toEqual({ kind: "error", message: "hello returned status=error (internal_error)" });
    expect(classifyBrokerHello({ status: "ok" })).toEqual({ kind: "error", message: "hello returned a malformed payload" });
    expect(classifyBrokerHello({ status: "ok", payload: { kind: "hello", protocol_version: "2", broker_version: "1" } }).kind).toBe("error");
    expect(classifyBrokerHello(null).kind).toBe("error");
  });
});
