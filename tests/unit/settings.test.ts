/**
 * Unit tests for the settings model in src/server/routes.ts.
 *
 * Covers:
 *   - effectiveAgentCmd: fallback rules
 *   - effectiveCmds: empty-list fallback to ["shell"]
 *   - loadSettings: legacy customCmds migration + bad-input filtering
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WOLFPACK_TEST = "1";

const { effectiveAgentCmd, effectiveCmds, effectiveRalphAgents, loadSettings, loadSettingsWithRalphAgents } = await import(
  "../../src/server/routes.ts"
);

// Each test gets its own settings file so they don't interfere.
function withSettingsFile(contents: unknown, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wolfpack-settings-test-"));
  const path = join(dir, "settings.json");
  if (contents !== undefined) {
    writeFileSync(path, JSON.stringify(contents));
  }
  const prev = process.env.WOLFPACK_SETTINGS_PATH;
  process.env.WOLFPACK_SETTINGS_PATH = path;
  try {
    fn();
  } finally {
    process.env.WOLFPACK_SETTINGS_PATH = prev;
    try { unlinkSync(path); } catch { /* missing is fine */ }
  }
}

describe("effectiveAgentCmd", () => {
  test("returns settings.agentCmd when it is enabled", () => {
    const s = {
      agentCmd: "claude",
      cmds: [
        { cmd: "shell", enabled: true },
        { cmd: "claude", enabled: true },
      ],
    };
    expect(effectiveAgentCmd(s)).toBe("claude");
  });

  test("falls through to first enabled cmd when settings.agentCmd is disabled", () => {
    const s = {
      agentCmd: "claude",
      cmds: [
        { cmd: "shell", enabled: true },
        { cmd: "claude", enabled: false },
        { cmd: "pi", enabled: true },
      ],
    };
    expect(effectiveAgentCmd(s)).toBe("shell");
  });

  test("falls through to first enabled cmd when settings.agentCmd is absent", () => {
    const s = {
      agentCmd: "missing",
      cmds: [
        { cmd: "pi", enabled: true },
        { cmd: "codex", enabled: true },
      ],
    };
    expect(effectiveAgentCmd(s)).toBe("pi");
  });

  test("falls through to \"shell\" when nothing is enabled", () => {
    const s = {
      agentCmd: "claude",
      cmds: [
        { cmd: "shell", enabled: false },
        { cmd: "claude", enabled: false },
      ],
    };
    expect(effectiveAgentCmd(s)).toBe("shell");
  });

  test("falls through to \"shell\" when cmds is empty", () => {
    expect(effectiveAgentCmd({ agentCmd: "anything", cmds: [] })).toBe("shell");
  });
});

describe("effectiveCmds", () => {
  test("returns enabled cmds in settings order", () => {
    const s = {
      agentCmd: "shell",
      cmds: [
        { cmd: "shell", enabled: true },
        { cmd: "claude", enabled: false },
        { cmd: "pi", enabled: true },
      ],
    };
    expect(effectiveCmds(s)).toEqual(["shell", "pi"]);
  });

  test("returns [\"shell\"] when nothing is enabled", () => {
    const s = {
      agentCmd: "claude",
      cmds: [
        { cmd: "claude", enabled: false },
        { cmd: "codex", enabled: false },
      ],
    };
    expect(effectiveCmds(s)).toEqual(["shell"]);
  });

  test("returns [\"shell\"] when cmds is empty", () => {
    expect(effectiveCmds({ agentCmd: "shell", cmds: [] })).toEqual(["shell"]);
  });
});

describe("effectiveRalphAgents", () => {
  test("returns enabled exact ralph agents only", () => {
    const settings = {
      agentCmd: "shell",
      cmds: [
        { cmd: "shell", enabled: true },
        { cmd: "claude", enabled: false },
        { cmd: "codex", enabled: true },
        { cmd: "gemini", enabled: true },
        { cmd: "cursor --model opus", enabled: true },
      ],
    };

    expect(effectiveRalphAgents(settings)).toEqual(["codex", "gemini"]);
  });
});

describe("loadSettingsWithRalphAgents", () => {
  test("does not classify synthesized defaults as configured Ralph agents", () => {
    withSettingsFile(undefined, () => {
      const loaded = loadSettingsWithRalphAgents();
      expect(loaded.settings.cmds.map(c => c.cmd)).toEqual(["shell", "claude", "pi", "codex"]);
      expect(loaded.ralphAgents).toEqual([]);
    });
  });

  test("preserves an explicitly empty persisted command list", () => {
    withSettingsFile({ agentCmd: "shell", cmds: [] }, () => {
      const loaded = loadSettingsWithRalphAgents();
      expect(loaded.settings.cmds).toEqual([]);
      expect(loaded.ralphAgents).toEqual([]);
    });
  });
});

describe("loadSettings — defaults", () => {
  test("returns the 4 baseline defaults when no settings file exists", () => {
    withSettingsFile(undefined, () => {
      const s = loadSettings();
      expect(s.agentCmd).toBe("shell");
      expect(s.cmds.map(c => c.cmd)).toEqual(["shell", "claude", "pi", "codex"]);
      expect(s.cmds.every(c => c.enabled)).toBe(true);
    });
  });

  test("returns defaults when the file is malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-settings-test-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ this is not valid json");
    const prev = process.env.WOLFPACK_SETTINGS_PATH;
    process.env.WOLFPACK_SETTINGS_PATH = path;
    try {
      const s = loadSettings();
      expect(s.cmds.map(c => c.cmd)).toEqual(["shell", "claude", "pi", "codex"]);
    } finally {
      process.env.WOLFPACK_SETTINGS_PATH = prev;
      try { unlinkSync(path); } catch { /* missing is fine */ }
    }
  });
});

describe("loadSettings — new shape", () => {
  test("roundtrips a clean { agentCmd, cmds } file", () => {
    withSettingsFile(
      {
        agentCmd: "pi",
        cmds: [
          { cmd: "shell", enabled: true },
          { cmd: "pi", enabled: true },
          { cmd: "claude", enabled: false },
        ],
      },
      () => {
        const s = loadSettings();
        expect(s.agentCmd).toBe("pi");
        expect(s.cmds).toEqual([
          { cmd: "shell", enabled: true },
          { cmd: "pi", enabled: true },
          { cmd: "claude", enabled: false },
        ]);
      },
    );
  });

  test("filters out invalid cmd strings", () => {
    withSettingsFile(
      {
        agentCmd: "shell",
        cmds: [
          { cmd: "shell", enabled: true },
          { cmd: "rm -rf /; echo pwned", enabled: true }, // injection attempt
          { cmd: "pi", enabled: true },
        ],
      },
      () => {
        const s = loadSettings();
        expect(s.cmds.map(c => c.cmd)).toEqual(["shell", "pi"]);
      },
    );
  });

  test("dedupes repeated cmd entries (first wins)", () => {
    withSettingsFile(
      {
        agentCmd: "shell",
        cmds: [
          { cmd: "shell", enabled: true },
          { cmd: "shell", enabled: false },
          { cmd: "claude", enabled: true },
        ],
      },
      () => {
        const s = loadSettings();
        expect(s.cmds).toEqual([
          { cmd: "shell", enabled: true },
          { cmd: "claude", enabled: true },
        ]);
      },
    );
  });

  test("rejects non-string agentCmd, falls back to \"shell\"", () => {
    withSettingsFile(
      {
        agentCmd: 42,
        cmds: [{ cmd: "claude", enabled: true }],
      },
      () => {
        expect(loadSettings().agentCmd).toBe("shell");
      },
    );
  });

  test("preserves an explicitly empty cmds array", () => {
    withSettingsFile(
      { agentCmd: "shell", cmds: [] },
      () => {
        expect(loadSettings().cmds).toEqual([]);
      },
    );
  });
});

describe("loadSettings — legacy migration", () => {
  test("migrates legacy customCmds[] into the new cmds[] alongside defaults", () => {
    withSettingsFile(
      {
        agentCmd: "claude",
        customCmds: ["my-tool", "another-tool"],
      },
      () => {
        const s = loadSettings();
        // Defaults come first, custom appended (order preserved within each).
        expect(s.cmds.map(c => c.cmd)).toEqual([
          "shell", "claude", "pi", "codex", "my-tool", "another-tool",
        ]);
        expect(s.cmds.every(c => c.enabled)).toBe(true);
        expect(s.agentCmd).toBe("claude");
      },
    );
  });

  test("legacy migration drops invalid customCmds entries", () => {
    withSettingsFile(
      {
        agentCmd: "shell",
        customCmds: ["good-cmd", "rm -rf /; echo pwn", 42, null, "another-good"],
      },
      () => {
        const s = loadSettings();
        const cmdNames = s.cmds.map(c => c.cmd);
        expect(cmdNames).toContain("good-cmd");
        expect(cmdNames).toContain("another-good");
        expect(cmdNames).not.toContain("rm -rf /; echo pwn");
      },
    );
  });

  test("legacy migration skips customCmds entries that collide with defaults", () => {
    withSettingsFile(
      {
        agentCmd: "shell",
        customCmds: ["claude", "pi", "user-tool"],
      },
      () => {
        const s = loadSettings();
        const cmdNames = s.cmds.map(c => c.cmd);
        // "claude" and "pi" are already defaults; only the unique addition appended.
        expect(cmdNames).toEqual(["shell", "claude", "pi", "codex", "user-tool"]);
      },
    );
  });
});
