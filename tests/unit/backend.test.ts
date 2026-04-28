import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initBackend,
  getBackend,
  getBackendType,
  __resetBackend,
  __setTestBackend,
  DEFAULT_BACKEND,
  type SessionBackend,
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

  // ── DEFAULT_BACKEND ──

  test("DEFAULT_BACKEND is 'broker'", () => {
    expect(DEFAULT_BACKEND).toBe("broker");
  });

  // ── initBackend ──

  test("initBackend() defaults to pty backend", () => {
    const backend = initBackend();
    expect(backend).toBeDefined();
    expect(getBackendType()).toBe("pty");
  });

  test("initBackend('pty') sets pty backend", () => {
    const backend = initBackend("pty");
    expect(backend).toBeDefined();
    expect(getBackendType()).toBe("pty");
  });

  test("initBackend returns the backend instance", () => {
    const backend = initBackend();
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.createSession).toBe("function");
    expect(typeof backend.killSession).toBe("function");
  });

  test("initBackend overwrites previous backend", () => {
    const first = initBackend("pty");
    const mock = new MockBackend();
    __setTestBackend(mock);
    expect(getBackend()).toBe(mock);
    // re-init replaces it
    const third = initBackend("pty");
    expect(getBackend()).toBe(third);
    expect(getBackend()).not.toBe(mock);
  });

  // ── getBackend ──

  test("getBackend auto-initializes when no backend set", () => {
    // after reset, no backend is set; auto-init falls back to pty when the
    // broker socket isn't reachable (which is always the case in unit tests).
    const backend = getBackend();
    expect(backend).toBeDefined();
    expect(getBackendType()).toBe("pty");
  });

  test("getBackend returns same instance after init", () => {
    const backend = initBackend();
    expect(getBackend()).toBe(backend);
    expect(getBackend()).toBe(backend); // idempotent
  });

  // ── getBackendType ──

  test("getBackendType returns the effective default before init", () => {
    // After reset + auto-init, the broker socket isn't reachable in unit
    // tests, so the router falls back to "pty" even though DEFAULT_BACKEND
    // is "broker".
    expect(getBackendType()).toBe("pty");
  });

  // ── __resetBackend ──

  test("__resetBackend clears the singleton", () => {
    initBackend();
    __resetBackend();
    // After reset, getBackend auto-inits with broker→pty fallback in unit env.
    const fresh = getBackend();
    expect(fresh).toBeDefined();
    expect(getBackendType()).toBe("pty");
  });

  test("__resetBackend resets backend type to default (effective)", () => {
    const mock = new MockBackend();
    __setTestBackend(mock, "broker");
    expect(getBackendType()).toBe("broker");
    __resetBackend();
    // Same fallback as above.
    expect(getBackendType()).toBe("pty");
  });

  test("__resetBackend throws outside test mode", () => {
    delete process.env.WOLFPACK_TEST;
    expect(() => __resetBackend()).toThrow("only available in test mode");
    // restore for afterEach
    process.env.WOLFPACK_TEST = "1";
  });

  // ── __setTestBackend ──

  test("__setTestBackend injects a mock backend", () => {
    const mock = new MockBackend();
    __setTestBackend(mock);
    expect(getBackend()).toBe(mock);
  });

  test("__setTestBackend defaults type to pty", () => {
    __setTestBackend(new MockBackend());
    expect(getBackendType()).toBe("pty");
  });

  test("__setTestBackend accepts custom type", () => {
    __setTestBackend(new MockBackend(), "broker");
    expect(getBackendType()).toBe("broker");
  });

  test("__setTestBackend throws outside test mode", () => {
    delete process.env.WOLFPACK_TEST;
    expect(() => __setTestBackend(new MockBackend())).toThrow("only available in test mode");
    process.env.WOLFPACK_TEST = "1";
  });
});
