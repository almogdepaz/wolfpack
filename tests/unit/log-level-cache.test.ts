import { afterEach, describe, expect, test, spyOn } from "bun:test";

process.env.WOLFPACK_TEST = "1";

const { createLogger, __resetLogLevelCache } = await import("../../src/log.ts");

afterEach(() => {
  delete process.env.WOLFPACK_LOG_LEVEL;
  __resetLogLevelCache();
});

describe("log level cache", () => {
  test("caches level until reset hook is called", () => {
    process.env.WOLFPACK_LOG_LEVEL = "error";
    __resetLogLevelCache();

    const outSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const log = createLogger("ws");
      log.info("i1"); // filtered at error level
      expect(outSpy).toHaveBeenCalledTimes(0);

      // mutate env without reset; cached level should remain "error"
      process.env.WOLFPACK_LOG_LEVEL = "debug";
      log.info("i2");
      expect(outSpy).toHaveBeenCalledTimes(0);

      // error still logs
      log.error("e1");
      expect(errSpy).toHaveBeenCalledTimes(1);

      // now reset cache; env=debug should take effect
      __resetLogLevelCache();
      log.info("i3");
      expect(outSpy).toHaveBeenCalledTimes(1);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
