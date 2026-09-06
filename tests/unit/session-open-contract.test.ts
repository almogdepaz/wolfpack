import { describe, expect, test } from "bun:test";
import { controlApiSource } from "../../src/control-api/schema.ts";

interface EnumSchema {
  readonly enum?: readonly unknown[];
}

describe("session-open shared contract", () => {
  test("keeps server, CLI mapping, and generated schema on one harness and error catalog", async () => {
    const contract = await import("../../src/session-open-contract.ts");
    const cli = await import("../../src/cli/session-control.ts");
    const server = await import("../../src/server/session-open.ts");
    const harnesses = [...contract.OPENABLE_HARNESSES];
    const errorCodes = Object.values(contract.SESSION_OPEN_ERROR);

    expect(new Set(harnesses).size).toBe(harnesses.length);
    for (const harness of harnesses) expect(contract.isOpenableHarness(harness)).toBe(true);
    expect(contract.isOpenableHarness("shell")).toBe(false);
    expect(contract.isOpenableHarness("future-agent")).toBe(false);

    const harnessSchema = controlApiSource.defs.OpenableHarness as EnumSchema;
    expect(harnessSchema.enum).toEqual(harnesses);

    expect(contract.SESSION_OPEN_HTTP_STATUS).toEqual({
      [contract.SESSION_OPEN_ERROR.INVALID_REQUEST]: 400,
      [contract.SESSION_OPEN_ERROR.PROJECT_NOT_FOUND]: 404,
      [contract.SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND]: 404,
      [contract.SESSION_OPEN_ERROR.PARENT_SESSION_CHANGED]: 409,
      [contract.SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE]: 503,
      [contract.SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS]: 400,
      [contract.SESSION_OPEN_ERROR.NAME_COLLISION]: 409,
      [contract.SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE]: 503,
      [contract.SESSION_OPEN_ERROR.TASK_WORKER_PREFLIGHT_FAILED]: 503,
      [contract.SESSION_OPEN_ERROR.TASK_WORKER_NOT_READY]: 503,
    });
    expect(controlApiSource.http["POST /api/session-open"]?.errors).toEqual([
      "400 INVALID_REQUEST|UNSUPPORTED_HARNESS",
      "404 PARENT_SESSION_NOT_FOUND|PROJECT_NOT_FOUND",
      "409 NAME_COLLISION|PARENT_SESSION_CHANGED",
      "503 BACKEND_UNAVAILABLE|PARENT_IDENTITY_UNAVAILABLE|TASK_WORKER_NOT_READY|TASK_WORKER_PREFLIGHT_FAILED",
      "503 TaskWorkerLaunchErrorEnvelope",
    ]);

    for (const code of [
      contract.SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND,
      contract.SESSION_OPEN_ERROR.PARENT_SESSION_CHANGED,
      contract.SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE,
      contract.SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS,
      contract.SESSION_OPEN_ERROR.NAME_COLLISION,
      contract.SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE,
    ]) {
      expect(new server.SessionOpenError(code).status).toBe(contract.SESSION_OPEN_HTTP_STATUS[code]);
    }

    for (const code of errorCodes) {
      expect(contract.isSessionOpenErrorCode(code)).toBe(true);
      expect(cli.sessionOpenCliError(code)).toEqual({
        message: expect.any(String),
        exitCode: expect.any(Number),
      });
    }
    expect(contract.isSessionOpenErrorCode("AUTH_REQUIRED")).toBe(false);
  });
});
