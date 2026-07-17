import { describe, expect, test } from "bun:test";
import { DuplicateSessionError } from "../../src/server/backend.ts";
import {
  chooseTopLevelSessionName,
  createTopLevelSession,
} from "../../src/server/session-create.ts";
import type { PublicSessionIdentity } from "../../src/server/session-identity.ts";

function identity(name: string, harness = "pi"): PublicSessionIdentity {
  return {
    wolfpackSessionId: `id:${name}`,
    wolfpackSessionName: name,
    projectPath: "/dev/branchout",
    agentKind: harness,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("top-level session creation", () => {
  test("chooses a project-scoped top-level name", () => {
    expect(chooseTopLevelSessionName("branchout", [])).toBe("branchout");
    expect(chooseTopLevelSessionName("branchout", ["branchout", "branchout-2"])).toBe("branchout-3");
    expect(chooseTopLevelSessionName("my.project", [])).toBe("my_project");
  });

  test("creates with an opaque initial prompt and returns stable identity", async () => {
    const creates: unknown[] = [];
    const result = await createTopLevelSession({
      backend: {
        list: async () => ["branchout"],
        createSession: async (name, cwd, cmd, _settings, options) => {
          creates.push({ name, cwd, cmd, options });
          return identity(name, cmd);
        },
      },
      project: "branchout",
      projectDir: "/dev/branchout",
      command: "pi",
      initialPrompt: "execute .plans/000-publish-branchout.md",
      loadSettings: () => ({ agentCmd: "claude" }),
    });

    expect(creates).toEqual([{
      name: "branchout-2",
      cwd: "/dev/branchout",
      cmd: "pi",
      options: {
        agentKind: "pi",
        initialPrompt: "execute .plans/000-publish-branchout.md",
      },
    }]);
    expect(result).toEqual({
      ok: true,
      session: "branchout-2",
      sessionId: "id:branchout-2",
      project: "branchout",
      harness: "pi",
    });
  });

  test("bounds concurrent name-collision retries", async () => {
    let calls = 0;
    const promise = createTopLevelSession({
      backend: {
        list: async () => [],
        createSession: async (name) => {
          calls++;
          throw new DuplicateSessionError(name);
        },
      },
      project: "branchout",
      projectDir: "/dev/branchout",
      command: "pi",
      loadSettings: () => ({ agentCmd: "pi" }),
    });

    await expect(promise).rejects.toBeInstanceOf(DuplicateSessionError);
    expect(calls).toBe(4);
  });

  test("retries a concurrent name collision", async () => {
    let calls = 0;
    const result = await createTopLevelSession({
      backend: {
        list: async () => calls === 0 ? [] : ["branchout"],
        createSession: async (name) => {
          calls++;
          if (calls === 1) throw new DuplicateSessionError(name);
          return identity(name);
        },
      },
      project: "branchout",
      projectDir: "/dev/branchout",
      command: "pi",
      loadSettings: () => ({ agentCmd: "pi" }),
    });

    expect(calls).toBe(2);
    expect(result.session).toBe("branchout-2");
    expect(result.sessionId).toBe("id:branchout-2");
  });
});
