import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initBackend,
  getBackend,
  __resetBackend,
  __setTestBackend,
} from "../../src/server/backend";
import { MockBackend } from "../../src/server/mock-backend";

describe("backend singleton", () => {
  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
    __resetBackend();
  });

  afterEach(() => {
    process.env.WOLFPACK_TEST = "1";
    __resetBackend();
  });

  test("initBackend() returns a backend instance", () => {
    const backend = initBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.createSession).toBe("function");
    expect(typeof backend.killSession).toBe("function");
  });

  test("initBackend overwrites previous backend", () => {
    const first = initBackend();
    const mock = new MockBackend();
    __setTestBackend(mock);
    expect(getBackend()).toBe(mock);
    const third = initBackend();
    expect(getBackend()).toBe(third);
    expect(getBackend()).not.toBe(mock);
    expect(first).toBeDefined();
  });

  test("getBackend auto-initializes when no backend set", () => {
    expect(getBackend()).toBeDefined();
  });

  test("getBackend returns same instance after init", () => {
    const backend = initBackend();
    expect(getBackend()).toBe(backend);
    expect(getBackend()).toBe(backend);
  });

  test("__resetBackend clears the singleton", () => {
    initBackend();
    __resetBackend();
    expect(getBackend()).toBeDefined();
  });

  test("__resetBackend throws outside test mode", () => {
    delete process.env.WOLFPACK_TEST;
    expect(() => __resetBackend()).toThrow("only available in test mode");
    process.env.WOLFPACK_TEST = "1";
  });

  test("__setTestBackend injects a mock backend", () => {
    const mock = new MockBackend();
    __setTestBackend(mock);
    expect(getBackend()).toBe(mock);
  });

  test("__setTestBackend throws outside test mode", () => {
    delete process.env.WOLFPACK_TEST;
    expect(() => __setTestBackend(new MockBackend())).toThrow("only available in test mode");
    process.env.WOLFPACK_TEST = "1";
  });
});
