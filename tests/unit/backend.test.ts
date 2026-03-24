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

  test("DEFAULT_BACKEND is 'pty'", () => {
    expect(DEFAULT_BACKEND).toBe("pty");
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
    // after reset, no backend is set
    const backend = getBackend();
    expect(backend).toBeDefined();
    expect(getBackendType()).toBe(DEFAULT_BACKEND);
  });

  test("getBackend returns same instance after init", () => {
    const backend = initBackend();
    expect(getBackend()).toBe(backend);
    expect(getBackend()).toBe(backend); // idempotent
  });

  // ── getBackendType ──

  test("getBackendType returns default before init", () => {
    // after reset, type is DEFAULT_BACKEND
    expect(getBackendType()).toBe(DEFAULT_BACKEND);
  });

  // ── __resetBackend ──

  test("__resetBackend clears the singleton", () => {
    initBackend();
    __resetBackend();
    // getBackend should auto-init a new one
    const fresh = getBackend();
    expect(fresh).toBeDefined();
    expect(getBackendType()).toBe(DEFAULT_BACKEND);
  });

  test("__resetBackend resets backend type to default", () => {
    const mock = new MockBackend();
    __setTestBackend(mock, "tmux");
    expect(getBackendType()).toBe("tmux");
    __resetBackend();
    expect(getBackendType()).toBe(DEFAULT_BACKEND);
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

  test("__setTestBackend defaults type to tmux", () => {
    __setTestBackend(new MockBackend());
    expect(getBackendType()).toBe("tmux");
  });

  test("__setTestBackend accepts custom type", () => {
    __setTestBackend(new MockBackend(), "pty");
    expect(getBackendType()).toBe("pty");
  });

  test("__setTestBackend throws outside test mode", () => {
    delete process.env.WOLFPACK_TEST;
    expect(() => __setTestBackend(new MockBackend())).toThrow("only available in test mode");
    process.env.WOLFPACK_TEST = "1";
  });
});
