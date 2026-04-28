process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_DEV_DIR = process.env.WOLFPACK_DEV_DIR || "/tmp/test-dev";
import { describe, expect, test } from "bun:test";
import * as configModule from "../../src/cli/config.js";
import { sessionDirMap, tmuxNewSession, __setTestOverrides } from "../../src/server/tmux.js";
import { uniqueSessionName } from "../../src/server/http.js";

describe("tmuxNewSession map update safety", () => {
  test("does not cache session dir when tmux session creation fails", async () => {
    // Use an invalid session name to force tmux rejection deterministically
    // across environments (rather than relying on PATH behavior).
    const sessionName = "";
    sessionDirMap.delete(sessionName);

    await expect(
      tmuxNewSession(sessionName, "/tmp", "shell", () => ({ agentCmd: "claude" })),
    ).rejects.toThrow();

    expect(sessionDirMap.has(sessionName)).toBe(false);
  });
});

describe("uniqueSessionName dot normalization", () => {
  async function mockSessions(names: string[]) {
    const { __setTestBackend } = await import("../../src/server/backend.js");
    const { MockBackend } = await import("../../src/server/mock-backend.js");
    const mock = new MockBackend({ sessions: names });
    __setTestBackend(mock);
    sessionDirMap.clear();
  }

  test("replaces dots with underscores to match tmux behavior", async () => {
    await mockSessions([]);
    expect(await uniqueSessionName("my.project")).toBe("my_project");
  });

  test("deduplicates after dot normalization", async () => {
    await mockSessions(["my_project"]);
    expect(await uniqueSessionName("my.project")).toBe("my_project-2");
  });

  test("multiple dots are all replaced", async () => {
    await mockSessions([]);
    expect(await uniqueSessionName("a.b.c")).toBe("a_b_c");
  });
});

describe("process command resolution for killPortHolder", () => {
  const resolveProcessCommandForValidation = (configModule as any)
    .resolveProcessCommandForValidation as
    | ((comm: string, args: string) => string)
    | undefined;

  test("falls back to args when comm is a generic wrapper binary", () => {
    expect(resolveProcessCommandForValidation).toBeDefined();
    expect(
      resolveProcessCommandForValidation?.(
        "bun",
        "bun /Users/home/Dev/wolfpack/cli.ts",
      ),
    ).toContain("wolfpack");
  });

  test("keeps comm when comm already identifies wolfpack", () => {
    expect(resolveProcessCommandForValidation).toBeDefined();
    expect(
      resolveProcessCommandForValidation?.(
        "/Users/home/.wolfpack/bin/wolfpack",
        "bun /Users/home/Dev/wolfpack/cli.ts",
      ),
    ).toBe("/Users/home/.wolfpack/bin/wolfpack");
  });
});
