import { describe, expect, test } from "bun:test";
import { DuplicateSessionError } from "../../src/server/backend.ts";
import type { SessionLaunchOptions } from "../../src/server/backend.ts";
import type { PublicSessionIdentity } from "../../src/server/session-identity.ts";
import {
  SESSION_OPEN_MAX_CREATE_ATTEMPTS,
  SessionOpenError,
  chooseSubAgentSessionName,
  openSubSession,
  type SessionOpenBackend,
} from "../../src/server/session-open.ts";

const PARENT_ID = "11111111-1111-1111-1111-111111111111";

function identity(
  name: string,
  agentKind: string = "pi",
  wolfpackSessionId: string = PARENT_ID,
): PublicSessionIdentity {
  return {
    wolfpackSessionId,
    wolfpackSessionName: name,
    projectPath: "/dev/parent",
    agentKind,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

interface CreateCall {
  readonly name: string;
  readonly cwd: string;
  readonly cmd: string | undefined;
  readonly options: SessionLaunchOptions | undefined;
}

class FakeSessionOpenBackend implements SessionOpenBackend {
  sessions: string[];
  identities: Record<string, PublicSessionIdentity>;
  readonly createCalls: CreateCall[] = [];
  readonly createFailures: Error[] = [];
  onList: ((count: number, backend: FakeSessionOpenBackend) => void) | undefined;
  private listCount = 0;

  constructor(parentName: string, agentKind: string = "pi") {
    this.sessions = [parentName];
    this.identities = { [parentName]: identity(parentName, agentKind) };
  }

  async list(): Promise<string[]> {
    this.listCount++;
    this.onList?.(this.listCount, this);
    return [...this.sessions];
  }

  async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    return { ...this.identities };
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    _loadSettings: () => { agentCmd: string },
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity> {
    this.createCalls.push({ name, cwd, cmd, options });
    const failure = this.createFailures.shift();
    if (failure) throw failure;
    this.sessions.push(name);
    const created = identity(name, cmd, `id:${name}`);
    this.identities[name] = created;
    return created;
  }
}

function expectSessionOpenError(error: unknown, code: SessionOpenError["code"]): void {
  expect(error).toBeInstanceOf(SessionOpenError);
  expect((error as SessionOpenError).code).toBe(code);
}

describe("server-owned sub-session naming", () => {
  test("chooses first and numbered names while preserving the suffix at 100 characters", () => {
    expect(chooseSubAgentSessionName("wolfpack", [])).toBe("wolfpack-sub-agent");
    expect(chooseSubAgentSessionName("wolfpack", ["wolfpack-sub-agent"]))
      .toBe("wolfpack-sub-agent-2");
    expect(chooseSubAgentSessionName(
      "wolfpack",
      ["wolfpack-sub-agent", "wolfpack-sub-agent-3"],
    )).toBe("wolfpack-sub-agent-2");

    const parent = "p".repeat(100);
    const first = chooseSubAgentSessionName(parent, []);
    const second = chooseSubAgentSessionName(parent, [first]);
    expect(first).toHaveLength(100);
    expect(first.endsWith("-sub-agent")).toBe(true);
    expect(second).toHaveLength(100);
    expect(second.endsWith("-sub-agent-2")).toBe(true);
  });
});

describe("openSubSession", () => {
  test("derives harness and exact parent identity and forwards the prompt unchanged", async () => {
    const backend = new FakeSessionOpenBackend("pi-main", "pi");
    backend.sessions.push("pi-main-sub-agent");
    const notifications: Array<{ parentId: string; parentName: string; session: string }> = [];
    const prompt = "review '$(touch /tmp/not-executed)' \"$HOME\"; done";

    const result = await openSubSession({
      backend,
      parentSession: "pi-main",
      project: "wolfpack",
      projectDir: "/dev/wolfpack",
      initialPrompt: prompt,
      notify: (parent, session) => {
        notifications.push({
          parentId: parent.wolfpackSessionId,
          parentName: parent.wolfpackSessionName,
          session,
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      session: "pi-main-sub-agent-2",
      sessionId: "id:pi-main-sub-agent-2",
      project: "wolfpack",
      harness: "pi",
    });
    expect(backend.createCalls).toEqual([{
      name: "pi-main-sub-agent-2",
      cwd: "/dev/wolfpack",
      cmd: "pi",
      options: {
        agentKind: "pi",
        parentSession: {
          wolfpackSessionId: PARENT_ID,
          wolfpackSessionName: "pi-main",
        },
        initialPrompt: prompt,
      },
    }]);
    expect(notifications).toEqual([{
      parentId: PARENT_ID,
      parentName: "pi-main",
      session: "pi-main-sub-agent-2",
    }]);
  });

  test("retries only typed duplicate collisions and stops at the bounded limit", async () => {
    const backend = new FakeSessionOpenBackend("pi-main");
    for (let attempt = 0; attempt < SESSION_OPEN_MAX_CREATE_ATTEMPTS; attempt++) {
      backend.createFailures.push(new DuplicateSessionError(`collision-${attempt}`));
    }
    backend.onList = (count, current) => {
      if (count > 1) current.sessions.push(`pi-main-sub-agent${count === 2 ? "" : `-${count - 1}`}`);
    };

    let failure: unknown;
    try {
      await openSubSession({
        backend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
      });
    } catch (error: unknown) {
      failure = error;
    }

    expectSessionOpenError(failure, "NAME_COLLISION");
    expect(backend.createCalls).toHaveLength(SESSION_OPEN_MAX_CREATE_ATTEMPTS);
  });

  test("does not retry untyped failures that merely resemble duplicates", async () => {
    const backend = new FakeSessionOpenBackend("pi-main");
    const lookalike = new Error("duplicate session");
    (lookalike as Error & { code: string }).code = "DUPLICATE_SESSION";
    backend.createFailures.push(lookalike);

    let failure: unknown;
    try {
      await openSubSession({
        backend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
      });
    } catch (error: unknown) {
      failure = error;
    }

    expectSessionOpenError(failure, "BACKEND_UNAVAILABLE");
    expect(backend.createCalls).toHaveLength(1);
  });

  test("fails closed before retry when the parent disappears", async () => {
    const backend = new FakeSessionOpenBackend("pi-main");
    backend.createFailures.push(new DuplicateSessionError("pi-main-sub-agent"));
    backend.onList = (count, current) => {
      if (count === 2) {
        current.sessions = [];
        current.identities = {};
      }
    };

    let failure: unknown;
    try {
      await openSubSession({
        backend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
      });
    } catch (error: unknown) {
      failure = error;
    }

    expectSessionOpenError(failure, "PARENT_SESSION_NOT_FOUND");
    expect(backend.createCalls).toHaveLength(1);
  });

  test("fails closed before retry when the parent name is replaced by another UUID", async () => {
    const backend = new FakeSessionOpenBackend("pi-main");
    backend.createFailures.push(new DuplicateSessionError("pi-main-sub-agent"));
    backend.onList = (count, current) => {
      if (count === 2) {
        current.identities = {
          "pi-main": identity("pi-main", "pi", "22222222-2222-2222-2222-222222222222"),
        };
      }
    };

    let failure: unknown;
    try {
      await openSubSession({
        backend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
      });
    } catch (error: unknown) {
      failure = error;
    }

    expectSessionOpenError(failure, "PARENT_SESSION_CHANGED");
    expect(backend.createCalls).toHaveLength(1);
  });

  test("rejects unavailable identity and unsupported shell or unknown harnesses", async () => {
    for (const agentKind of ["shell", "unknown"]) {
      const backend = new FakeSessionOpenBackend("parent", agentKind);
      let failure: unknown;
      try {
        await openSubSession({
          backend,
          parentSession: "parent",
          project: "wolfpack",
          projectDir: "/dev/wolfpack",
        });
      } catch (error: unknown) {
        failure = error;
      }
      expectSessionOpenError(failure, "UNSUPPORTED_HARNESS");
      expect(backend.createCalls).toEqual([]);
    }

    const backend = new FakeSessionOpenBackend("parent");
    backend.identities = {};
    let failure: unknown;
    try {
      await openSubSession({
        backend,
        parentSession: "parent",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
      });
    } catch (error: unknown) {
      failure = error;
    }
    expectSessionOpenError(failure, "PARENT_IDENTITY_UNAVAILABLE");
    expect(backend.createCalls).toEqual([]);
  });

  test("notifies only after success", async () => {
    const failedBackend = new FakeSessionOpenBackend("pi-main");
    failedBackend.createFailures.push(new Error("broker down"));
    const failedNotifications: string[] = [];
    await expect(openSubSession({
      backend: failedBackend,
      parentSession: "pi-main",
      project: "wolfpack",
      projectDir: "/dev/wolfpack",
      notify: (_parent, session) => failedNotifications.push(session),
    })).rejects.toBeInstanceOf(SessionOpenError);
    expect(failedNotifications).toEqual([]);
  });

  test("fails closed after creation when the parent disappears or is replaced", async () => {
    const disappearedBackend = new FakeSessionOpenBackend("pi-main");
    disappearedBackend.onList = (count, current) => {
      if (count === 2) {
        current.sessions = [];
        current.identities = {};
      }
    };
    const disappearedNotifications: string[] = [];
    let disappearedFailure: unknown;
    try {
      await openSubSession({
        backend: disappearedBackend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
        notify: (_parent, session) => disappearedNotifications.push(session),
      });
    } catch (error: unknown) {
      disappearedFailure = error;
    }
    expectSessionOpenError(disappearedFailure, "PARENT_SESSION_NOT_FOUND");
    expect(disappearedBackend.createCalls).toHaveLength(1);
    expect(disappearedNotifications).toEqual([]);

    const replacedBackend = new FakeSessionOpenBackend("pi-main");
    replacedBackend.onList = (count, current) => {
      if (count === 2) {
        current.identities = {
          "pi-main": identity("pi-main", "pi", "22222222-2222-2222-2222-222222222222"),
        };
      }
    };
    const staleNotifications: string[] = [];
    let replacedFailure: unknown;
    try {
      await openSubSession({
        backend: replacedBackend,
        parentSession: "pi-main",
        project: "wolfpack",
        projectDir: "/dev/wolfpack",
        notify: (_parent, session) => staleNotifications.push(session),
      });
    } catch (error: unknown) {
      replacedFailure = error;
    }
    expectSessionOpenError(replacedFailure, "PARENT_SESSION_CHANGED");
    expect(replacedBackend.createCalls).toHaveLength(1);
    expect(staleNotifications).toEqual([]);
  });
});
