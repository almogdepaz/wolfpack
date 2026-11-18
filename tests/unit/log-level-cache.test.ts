import { expect, spyOn, test } from "bun:test";
import { createLogger, type LogLevel } from "../../src/log.ts";

test("default log level is lazy, cached across env changes, and reloaded by SIGHUP", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, WOLFPACK_LOG_LEVEL: "debug" };
  delete env.WOLFPACK_TEST;
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { createLogger } = await import(${JSON.stringify(new URL("../../src/log.ts", import.meta.url).href)});
    const log = createLogger("ws");
    process.env.WOLFPACK_LOG_LEVEL = "error";
    log.info("first filtered");
    process.env.WOLFPACK_LOG_LEVEL = "debug";
    log.info("still filtered");
    log.error("error allowed");
    process.emit("SIGHUP");
    log.info("reloaded");
  `], { env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString().trim().split("\n").map(line => JSON.parse(line).msg)).toEqual(["reloaded"]);
  expect(child.stderr.toString().trim().split("\n").map(line => JSON.parse(line).msg)).toEqual(["error allowed"]);
});

test("explicit logger level providers remain independent", () => {
  let level: LogLevel = "error";
  const out = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const first = createLogger("ws", { level: () => level });
    const second = createLogger("ws", { level: () => "error" });
    first.info("filtered");
    second.info("also filtered");
    level = "debug";
    first.info("first allowed");
    second.info("second still filtered");
    expect(out.mock.calls.map(([line]) => JSON.parse(String(line)).msg)).toEqual(["first allowed"]);
  } finally {
    out.mockRestore();
  }
});
