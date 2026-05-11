import { describe, expect, test } from "bun:test";
import { remoteUrl, type Config } from "../../src/cli/config.ts";
import { planServiceEnsureAction, hasUninstallConfirmationFlag } from "../../src/cli/index.ts";

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

  test("preserves hostname exactly", () => {
    expect(remoteUrl({ ...base, tailscaleHostname: "my-machine.tailnet.ts.net" }))
      .toBe("https://my-machine.tailnet.ts.net");
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
