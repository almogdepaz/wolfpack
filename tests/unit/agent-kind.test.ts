import { describe, expect, test } from "bun:test";
import {
  AGENT_KIND,
  detectAgentKindFromCommandArgs,
  inferAgentKindFromCommand,
  resolveAgentCommand,
} from "../../src/agent-kind.ts";

describe("agent kinds", () => {
  test("does not infer cursor from Wolfpack's opaque argv marker", () => {
    expect(detectAgentKindFromCommandArgs(["zsh", "-lic", "wolfpack-agent"])).toBeUndefined();
  });

  test("owns only built-in definitions and resolves canonical executables", () => {
    expect(AGENT_KIND.CURSOR).toEqual({ id: "cursor", cmd: "agent" });
    expect(Object.keys(AGENT_KIND)).not.toContain("UNKNOWN");

    const definitions = Object.values(AGENT_KIND);
    for (const definition of definitions) {
      expect(resolveAgentCommand(definition.id)).toBe(definition.cmd);
    }
    expect(resolveAgentCommand("cursor-custom")).toBe("cursor-custom");
    expect(resolveAgentCommand("unknown")).toBe("unknown");
  });

  test("classifies built-in ids and executables while collapsing other commands to custom", () => {
    expect(inferAgentKindFromCommand(undefined)).toBe("shell");
    expect(inferAgentKindFromCommand("  ")).toBe("shell");
    expect(inferAgentKindFromCommand("cursor")).toBe("cursor");
    expect(inferAgentKindFromCommand("/usr/local/bin/agent --resume")).toBe("cursor");
    expect(inferAgentKindFromCommand("cursor-custom")).toBe("custom");
    expect(inferAgentKindFromCommand("another-custom-agent")).toBe("custom");
    expect(inferAgentKindFromCommand("unknown")).toBe("custom");
  });
});
