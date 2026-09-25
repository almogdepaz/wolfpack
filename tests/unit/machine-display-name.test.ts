import { describe, expect, test } from "bun:test";
import { getMachineDisplayName, readComputerName, resolveMachineDisplayName } from "../../src/machine-display-name.ts";
import { isMachineDisplayName } from "../../src/tailnet-machine-contract.ts";

describe("server-owned machine display name", () => {
  test("resolves a future configured name before computer name and hostname", () => {
    expect(resolveMachineDisplayName({ configuredName: "  Studio  ", computerName: "Computer", hostName: "host.local" })).toBe("Studio");
  });
  test("uses the friendly computer name without hostname rewriting", () => {
    expect(resolveMachineDisplayName({ computerName: "Almog’s MacBook Pro\n", hostName: "oldsgt.local" })).toBe("Almog’s MacBook Pro");
    expect(resolveMachineDisplayName({ computerName: "Studio.local", hostName: "host" })).toBe("Studio.local");
  });
  test("falls back to the existing short hostname convention", () => {
    expect(resolveMachineDisplayName({ hostName: "studio.local" })).toBe("studio");
    expect(resolveMachineDisplayName({ hostName: "studio.tailabc.ts.net" })).toBe("studio");
  });
  test("ignores missing, blank, non-string, control-character and oversized names", () => {
    for (const invalid of [undefined, null, " ", 42, {}, "bad\nname", "bad\u0085name", "x".repeat(129)]) {
      expect(resolveMachineDisplayName({ configuredName: invalid, computerName: "Friendly", hostName: "host" })).toBe("Friendly");
      expect(resolveMachineDisplayName({ computerName: invalid, hostName: "host" })).toBe("host");
    }
  });
  test("keeps a valid bounded fallback even if hostname is unusable", () => {
    expect(resolveMachineDisplayName({ hostName: "" })).toBe("this machine");
    expect(resolveMachineDisplayName({ hostName: "bad\u0000host" })).toBe("this machine");
    expect(resolveMachineDisplayName({ hostName: "x".repeat(129) })).toBe("this machine");
  });
  test("exposes one valid process-startup default", () => {
    const name = getMachineDisplayName();
    expect(isMachineDisplayName(name)).toBe(true);
    expect(getMachineDisplayName()).toBe(name);
  });
});

describe("bounded OS computer-name discovery", () => {
  test("uses the fixed macOS read command without a shell", () => {
    expect(readComputerName("darwin", (file, args, options) => {
      expect(file).toBe("/usr/sbin/scutil");
      expect(args).toEqual(["--get", "ComputerName"]);
      expect(options).toEqual({ encoding: "utf8", timeout: 500, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"] });
      return "Friendly Mac\n";
    })).toBe("Friendly Mac\n");
  });
  test("reads Linux's pretty hostname without shell parsing", () => {
    expect(readComputerName("linux", (file, args) => {
      expect(file).toBe("/usr/bin/hostnamectl");
      expect(args).toEqual(["--pretty"]);
      return "Studio workstation\n";
    })).toBe("Studio workstation\n");
  });
  test("does not launch a command on other platforms", () => {
    let calls = 0;
    expect(readComputerName("win32", () => { calls++; return "unused"; })).toBeUndefined();
    expect(calls).toBe(0);
  });
  test("missing command, timeout and output-limit failures use the fallback", () => {
    for (const reason of ["ENOENT", "timeout", "maxBuffer exceeded"]) {
      expect(readComputerName("darwin", () => { throw new Error(reason); })).toBeUndefined();
    }
  });
});
