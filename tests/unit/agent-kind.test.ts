import { describe, expect, test } from "bun:test";
import {
  AGENT_KIND,
  detectAgentKindFromCommandArgs,
  resolveAgentCommand,
} from "../../src/agent-kind.ts";

describe("agent kinds", () => {
  test("does not infer cursor from Wolfpack's opaque argv marker", () => {
    expect(detectAgentKindFromCommandArgs(["zsh", "-lic", "wolfpack-agent"])).toBeUndefined();
  });

  test("owns canonical ids and executable command resolution", () => {
    expect(AGENT_KIND.CURSOR).toEqual({ id: "cursor", cmd: "agent" });

    const definitions = Object.values(AGENT_KIND);
    for (const definition of definitions) {
      expect(resolveAgentCommand(definition.id)).toBe(definition.cmd);
    }
    expect(resolveAgentCommand("cursor-custom --resume")).toBe("cursor-custom --resume");
  });
});
