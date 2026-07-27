import { describe, expect, test, spyOn } from "bun:test";
import { createLogger } from "../../src/log.js";

describe("logger extra key collision", () => {
  test("reserved fields survive when extra tries to overwrite them (error level)", () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const log = createLogger("ws");
      log.error("hello", {
        ts: "evil",
        level: "debug",
        component: "pty",
        msg: "overwrite",
        customKey: 42,
      } as Record<string, unknown>);

      expect(spy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse((spy.mock.calls[0][0] as string).trim());

      // Reserved fields must NOT be overwritten by extra
      expect(entry.level).toBe("error");
      expect(entry.component).toBe("ws");
      expect(entry.msg).toBe("hello");
      expect(entry.ts).not.toBe("evil");
      // Custom keys still pass through
      expect(entry.customKey).toBe(42);
    } finally {
      spy.mockRestore();
    }
  });

  test("reserved fields survive when extra tries to overwrite them (info level)", () => {
    const spy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const log = createLogger("routes");
      log.info("test msg", {
        ts: "bad-ts",
        msg: "bad-msg",
      } as Record<string, unknown>);

      expect(spy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse((spy.mock.calls[0][0] as string).trim());

      expect(entry.level).toBe("info");
      expect(entry.component).toBe("routes");
      expect(entry.msg).toBe("test msg");
      expect(entry.ts).not.toBe("bad-ts");
    } finally {
      spy.mockRestore();
    }
  });
});
