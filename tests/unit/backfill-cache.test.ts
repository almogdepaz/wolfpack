import { describe, expect, test, beforeEach } from "bun:test";
import {
  tmuxList,
  BACKFILL_CACHE_TTL_MS,
  __setTestOverrides,
  __resetTmuxListFn,
  __clearBackfillCache,
  __getBackfillCacheSize,
} from "../../src/server/tmux.ts";
import { sessionDirMap } from "../../src/server/dev-dir.ts";

// set test mode + DEV_DIR so isUnderDevDir() passes
process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_DEV_DIR = "/Users/test/Dev";

const DEV = "/Users/test/Dev";

function makeListOutput(count: number): string {
  return Array.from({ length: count }, (_, i) => `session${i}|||${DEV}/project${i}`).join("\n");
}

describe("show-environment backfill cache", () => {
  beforeEach(() => {
    // Reset _tmuxListFn to _realTmuxList — integration tests set it at module-load
    // time and in bun 1.3.11+ module state is shared across files in a single run.
    __resetTmuxListFn();
    sessionDirMap.clear();
    __clearBackfillCache();
  });

  test("20 sessions → show-environment called once per session on first poll", async () => {
    const N = 20;
    let showEnvCalls = 0;
    const calledSessions = new Set<string>();

    __setTestOverrides({
      listSessionsRaw: async () => makeListOutput(N),
      showEnvironment: async (session: string) => {
        showEnvCalls++;
        calledSessions.add(session);
        return `WOLFPACK_PROJECT_DIR=${DEV}/project-env-${session}\n`;
      },
    });

    // bypass the tmuxList override — we need _realTmuxList to run
    // __setTestOverrides sets listSessionsRaw/showEnvironment but tmuxList is not overridden,
    // so tmuxList() calls _realTmuxList which uses our hooks
    const sessions = await tmuxList();

    expect(sessions.length).toBe(N);
    expect(showEnvCalls).toBe(N);
    expect(calledSessions.size).toBe(N);
    expect(__getBackfillCacheSize()).toBe(N);
  });

  test("re-poll does not call show-environment (sessionDirMap populated)", async () => {
    const N = 20;
    let showEnvCalls = 0;

    __setTestOverrides({
      listSessionsRaw: async () => makeListOutput(N),
      showEnvironment: async (session: string) => {
        showEnvCalls++;
        return `WOLFPACK_PROJECT_DIR=${DEV}/project-env\n`;
      },
    });

    // first poll — populates cache + sessionDirMap
    await tmuxList();
    expect(showEnvCalls).toBe(N);

    // second poll — sessionDirMap has all entries, no show-environment calls
    showEnvCalls = 0;
    await tmuxList();
    expect(showEnvCalls).toBe(0);
  });

  test("backfill cache prevents show-environment when sessionDirMap cleared but cache valid", async () => {
    let showEnvCalls = 0;

    __setTestOverrides({
      listSessionsRaw: async () => `mysession|||${DEV}/myproject`,
      showEnvironment: async () => {
        showEnvCalls++;
        return `WOLFPACK_PROJECT_DIR=${DEV}/resolved\n`;
      },
    });

    // first poll
    await tmuxList();
    expect(showEnvCalls).toBe(1);
    expect(sessionDirMap.get("mysession")).toBe(`${DEV}/resolved`);

    // simulate server restart clearing sessionDirMap but not cache
    sessionDirMap.clear();
    showEnvCalls = 0;

    // second poll — cache still valid, should use cached dir
    await tmuxList();
    expect(showEnvCalls).toBe(0);
    expect(sessionDirMap.get("mysession")).toBe(`${DEV}/resolved`);
  });

  test("expired cache triggers fresh show-environment", async () => {
    let showEnvCalls = 0;

    __setTestOverrides({
      listSessionsRaw: async () => `mysession|||${DEV}/myproject`,
      showEnvironment: async () => {
        showEnvCalls++;
        return `WOLFPACK_PROJECT_DIR=${DEV}/resolved\n`;
      },
    });

    // first poll
    await tmuxList();
    expect(showEnvCalls).toBe(1);

    // clear sessionDirMap AND expire the cache by manipulating time
    sessionDirMap.clear();
    showEnvCalls = 0;

    // force-expire: clear and re-run (simulates TTL expiry)
    __clearBackfillCache();

    await tmuxList();
    expect(showEnvCalls).toBe(1);
  });

  test("session deletion prunes backfill cache", async () => {
    __setTestOverrides({
      listSessionsRaw: async () => `session1|||${DEV}/p1\nsession2|||${DEV}/p2`,
      showEnvironment: async () => `WOLFPACK_PROJECT_DIR=${DEV}/resolved\n`,
    });

    await tmuxList();
    expect(__getBackfillCacheSize()).toBe(2);

    // session2 disappears
    __setTestOverrides({
      listSessionsRaw: async () => `session1|||${DEV}/p1`,
      showEnvironment: async () => `WOLFPACK_PROJECT_DIR=${DEV}/resolved\n`,
    });

    await tmuxList();
    expect(__getBackfillCacheSize()).toBe(1);
    expect(sessionDirMap.has("session2")).toBe(false);
  });

  test("show-environment failure falls back to pane dir and caches it", async () => {
    let showEnvCalls = 0;

    __setTestOverrides({
      listSessionsRaw: async () => `broken|||${DEV}/fallback`,
      showEnvironment: async () => {
        showEnvCalls++;
        throw new Error("no such env var");
      },
    });

    await tmuxList();
    expect(showEnvCalls).toBe(1);
    expect(sessionDirMap.get("broken")).toBe(`${DEV}/fallback`);

    // re-poll with cleared sessionDirMap — should use cache, not re-call show-environment
    sessionDirMap.clear();
    showEnvCalls = 0;
    await tmuxList();
    expect(showEnvCalls).toBe(0);
    expect(sessionDirMap.get("broken")).toBe(`${DEV}/fallback`);
  });
});
