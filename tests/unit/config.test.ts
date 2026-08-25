import { describe, expect, test } from "bun:test";
import { remoteUrl, type Config } from "../../src/cli/config.ts";
import {
  planBinaryUpdateAction,
  planServiceEnsureAction,
  hasUninstallConfirmationFlag,
  parseServiceCommand,
} from "../../src/cli/index.ts";

describe("remoteUrl", () => {
  const base: Config = { devDir: "/home/dev", port: 18790 };

  test("returns https URL when tailscaleHostname is set", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "box.tail1234.ts.net" }))
      .toBe("https://box.tail1234.ts.net");
  });

  test("returns null when tailscaleHostname is undefined", () => {
    expect(remoteUrl(base)).toBeNull();
  });

  test("returns null when tailscaleHostname is empty string", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "" })).toBeNull();
  });

  test("returns only a canonical Tailnet origin", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "my-machine.tailnet.ts.net" }))
      .toBe("https://my-machine.tailnet.ts.net");
    expect(remoteUrl({ ...base, tailscaleHostname: "https://evil.example" }))
      .toBeNull();
  });
});

describe("planServiceEnsureAction", () => {
  test("does nothing when service is already running", () => {
    expect(planServiceEnsureAction(true, true)).toBe("noop");
    expect(planServiceEnsureAction(true, false)).toBe("noop");
  });

  test("starts an installed but stopped service", () => {
    expect(planServiceEnsureAction(false, true)).toBe("start");
  });

  test("installs the service when it is not yet installed", () => {
    expect(planServiceEnsureAction(false, false)).toBe("install");
  });
});

describe("planBinaryUpdateAction", () => {
  test("restarts only the running server after a binary update", () => {
    expect(planBinaryUpdateAction(true, true, true)).toBe("server-restart");
  });

  test("falls back to normal service planning when no running binary was replaced", () => {
    expect(planBinaryUpdateAction(false, true, true)).toBe("noop");
    expect(planBinaryUpdateAction(false, false, true)).toBe("start");
    expect(planBinaryUpdateAction(false, false, false)).toBe("install");
  });

  test("installs when an updated binary has no running service to restart", () => {
    expect(planBinaryUpdateAction(true, false, false)).toBe("install");
  });
});

describe("hasUninstallConfirmationFlag", () => {
  test("accepts --yes", () => {
    expect(hasUninstallConfirmationFlag(["--yes"])).toBe(true);
  });

  test("accepts --force", () => {
    expect(hasUninstallConfirmationFlag(["--force"])).toBe(true);
  });

  test("rejects missing confirmation flag", () => {
    expect(hasUninstallConfirmationFlag([])).toBe(false);
    expect(hasUninstallConfirmationFlag(["--dry-run"])).toBe(false);
  });
});

describe("parseServiceCommand", () => {
  test("parses every accepted service action", () => {
    for (const action of ["install", "uninstall", "stop", "start", "restart", "status"] as const) {
      expect(parseServiceCommand([action])).toEqual({ action, broker: false, serverOnly: false });
      expect(parseServiceCommand([action, "--broker"])).toEqual({ action, broker: true, serverOnly: false });
    }
    expect(parseServiceCommand(["restart", "--server-only"]))
      .toEqual({ action: "restart", broker: false, serverOnly: true });
  });

  test("treats duplicate broker flags as idempotent", () => {
    expect(parseServiceCommand(["restart", "--broker", "--broker"]))
      .toEqual({ action: "restart", broker: true, serverOnly: false });
  });

  test("rejects server-only outside restart or together with broker", () => {
    expect(parseServiceCommand(["stop", "--server-only"])).toBeNull();
    expect(parseServiceCommand(["restart", "--broker", "--server-only"])).toBeNull();
  });

  test("rejects missing actions, flag-only input, unknown flags, and unknown actions", () => {
    expect(parseServiceCommand([])).toBeNull();
    expect(parseServiceCommand(["--broker"])).toBeNull();
    expect(parseServiceCommand(["restart", "--wat"])).toBeNull();
    expect(parseServiceCommand(["nuke"])).toBeNull();
  });
});
