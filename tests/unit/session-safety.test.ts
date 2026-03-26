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
  const DEV = process.env.WOLFPACK_DEV_DIR!;

  function mockSessions(names: string[]) {
    // Use listSessionsRaw so _tmuxListFn stays as _realTmuxList (no cross-test pollution)
    const raw = names.map(n => `${n}|||${DEV}/${n}`).join("\n");
    __setTestOverrides({
      listSessionsRaw: async () => raw,
      showEnvironment: async () => "",
    });
    sessionDirMap.clear();
  }

  test("replaces dots with underscores to match tmux behavior", async () => {
    mockSessions([]);
    expect(await uniqueSessionName("my.project")).toBe("my_project");
  });

  test("deduplicates after dot normalization", async () => {
    mockSessions(["my_project"]);
    expect(await uniqueSessionName("my.project")).toBe("my_project-2");
  });

  test("multiple dots are all replaced", async () => {
    mockSessions([]);
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
