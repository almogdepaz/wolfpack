import { describe, test, expect } from "bun:test";
import { createServerContext } from "../../src/server/context";
import { MockBackend } from "../../src/server/mock-backend";

describe("context-owned backend", () => {
  test("default construction provides the backend contract", () => {
    const { backend } = createServerContext({ startSupervisor: false });
    expect(backend).toBeDefined();
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.createSession).toBe("function");
    expect(typeof backend.killSession).toBe("function");
  });

  test("constructing another context does not replace an owned backend", () => {
    const first = createServerContext({ startSupervisor: false });
    const mock = new MockBackend();
    const second = createServerContext({ backend: mock });
    const third = createServerContext({ startSupervisor: false });
    expect(second.backend).toBe(mock);
    expect(first.backend).not.toBe(third.backend);
    expect(third.backend).not.toBe(mock);
    expect(second.backend).toBe(mock);
  });

  test("default construction does not require prior global initialization", () => {
    expect(createServerContext({ startSupervisor: false }).backend).toBeDefined();
  });

  test("context retains the same backend instance", () => {
    const context = createServerContext({ startSupervisor: false });
    const backend = context.backend;
    expect(context.backend).toBe(backend);
    expect(context.backend).toBe(backend);
  });

  test("an injected backend does not start a broker outside test mode", () => {
    const priorTestMode = process.env.WOLFPACK_TEST;
    delete process.env.WOLFPACK_TEST;
    try {
      const backend = new MockBackend();
      const context = createServerContext({ backend });
      expect(context.backend).toBe(backend);
      expect(context.supervisor).toBeUndefined();
    } finally {
      if (priorTestMode === undefined) delete process.env.WOLFPACK_TEST;
      else process.env.WOLFPACK_TEST = priorTestMode;
    }
  });

  test("backend injection is local even without a test-mode guard", async () => {
    const priorTestMode = process.env.WOLFPACK_TEST;
    delete process.env.WOLFPACK_TEST;
    try {
      const first = createServerContext({ backend: new MockBackend({ sessions: ["first"] }) });
      const second = createServerContext({ backend: new MockBackend({ sessions: ["second"] }) });
      expect(await first.backend.list()).toEqual(["first"]);
      expect(await second.backend.list()).toEqual(["second"]);
    } finally {
      if (priorTestMode === undefined) delete process.env.WOLFPACK_TEST;
      else process.env.WOLFPACK_TEST = priorTestMode;
    }
  });
});
