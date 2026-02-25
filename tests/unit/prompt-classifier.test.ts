import { describe, expect, test } from "bun:test";

// ── Prompt classifier (mirrors public/index.html PROMPT_PATTERNS + detectPrompt) ──
// These must stay in sync with the frontend patterns.

const PROMPT_PATTERNS = [
  /\? ?\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\[yes\/no\]/i,
  /\(yes\/no\)/i,
  /Do you want to /i,
  /Would you like to /i,
  /Press Enter/i,
  /press any key/i,
  /Continue\?/i,
  /Proceed\?/i,
  /\bconfirm\b.*\?/i,
  /\bapprove\b/i,
  /\bpermission\b/i,
  /waiting for (?:input|response|approval|confirmation)/i,
  /\bAccept\b.*\?/,
  /\(Y\)es.*\(N\)o/i,
  /\[Enter\]/i,
];

function detectPrompt(text: string): boolean {
  if (!text) return false;
  const lines = text.trimEnd().split("\n").slice(-5);
  const tail = lines.join("\n");
  return PROMPT_PATTERNS.some((p) => p.test(tail));
}

// ── Positive matches: should detect prompt ──

describe("prompt classifier — positive matches", () => {
  test("y/n with question mark", () => {
    expect(detectPrompt("Overwrite file? (y/n)")).toBe(true);
  });

  test("y/n no space before paren", () => {
    expect(detectPrompt("Continue?(y/n)")).toBe(true);
  });

  test("[Y/n] bracket style", () => {
    expect(detectPrompt("Install packages? [Y/n]")).toBe(true);
  });

  test("[y/N] bracket style (default no)", () => {
    expect(detectPrompt("Delete all? [y/N]")).toBe(true);
  });

  test("[yes/no] bracket style", () => {
    expect(detectPrompt("Are you sure? [yes/no]")).toBe(true);
  });

  test("(yes/no) paren style", () => {
    expect(detectPrompt("Remove entry (yes/no)")).toBe(true);
  });

  test("Do you want to ...", () => {
    expect(detectPrompt("Do you want to continue?")).toBe(true);
  });

  test("Would you like to ...", () => {
    expect(detectPrompt("Would you like to install?")).toBe(true);
  });

  test("Press Enter to continue", () => {
    expect(detectPrompt("Press Enter to continue")).toBe(true);
  });

  test("press any key", () => {
    expect(detectPrompt("press any key to exit")).toBe(true);
  });

  test("Continue?", () => {
    expect(detectPrompt("Continue?")).toBe(true);
  });

  test("Proceed?", () => {
    expect(detectPrompt("Proceed?")).toBe(true);
  });

  test("confirm with question", () => {
    expect(detectPrompt("Please confirm this action?")).toBe(true);
  });

  test("approve keyword", () => {
    expect(detectPrompt("Type approve to continue")).toBe(true);
  });

  test("permission keyword", () => {
    expect(detectPrompt("Grant permission to access files")).toBe(true);
  });

  test("waiting for input", () => {
    expect(detectPrompt("waiting for input...")).toBe(true);
  });

  test("waiting for approval", () => {
    expect(detectPrompt("waiting for approval")).toBe(true);
  });

  test("waiting for confirmation", () => {
    expect(detectPrompt("waiting for confirmation")).toBe(true);
  });

  test("Accept with question", () => {
    expect(detectPrompt("Accept these changes?")).toBe(true);
  });

  test("(Y)es / (N)o style", () => {
    expect(detectPrompt("Apply patch? (Y)es (N)o")).toBe(true);
  });

  test("[Enter] in prompt", () => {
    expect(detectPrompt("Press [Enter] to accept default")).toBe(true);
  });

  test("case insensitive: DO YOU WANT TO", () => {
    expect(detectPrompt("DO YOU WANT TO PROCEED?")).toBe(true);
  });
});

// ── Prompt in last 5 lines ──

describe("prompt classifier — line window", () => {
  test("prompt on last line with preceding output", () => {
    const text =
      "Building...\nCompiling modules...\nDone.\n\nOverwrite config? (y/n)";
    expect(detectPrompt(text)).toBe(true);
  });

  test("prompt 4 lines from end", () => {
    const text =
      "Do you want to continue?\nline2\nline3\nline4\nline5";
    expect(detectPrompt(text)).toBe(true);
  });

  test("prompt 6 lines from end (outside window)", () => {
    const text =
      "Do you want to continue?\nline2\nline3\nline4\nline5\nline6";
    expect(detectPrompt(text)).toBe(false);
  });

  test("trailing whitespace is trimmed before slicing", () => {
    const text = "Continue? (y/n)\n\n\n";
    expect(detectPrompt(text)).toBe(true);
  });
});

// ── Negative matches: should NOT detect prompt ──

describe("prompt classifier — negative matches", () => {
  test("plain error line", () => {
    expect(detectPrompt("Error: module not found")).toBe(false);
  });

  test("failed build output", () => {
    expect(detectPrompt("Build failed with 3 errors")).toBe(false);
  });

  test("normal command output", () => {
    expect(detectPrompt("$ npm install\nadded 42 packages")).toBe(false);
  });

  test("empty string", () => {
    expect(detectPrompt("")).toBe(false);
  });

  test("only whitespace", () => {
    expect(detectPrompt("   \n\n  ")).toBe(false);
  });

  test("git log output", () => {
    expect(detectPrompt("abc1234 fix: resolve merge conflict")).toBe(false);
  });

  test("word 'continue' without question mark", () => {
    expect(detectPrompt("will continue processing in background")).toBe(false);
  });

  test("word 'proceed' without question mark", () => {
    expect(detectPrompt("we proceed to the next step")).toBe(false);
  });

  test("progress bar output", () => {
    expect(detectPrompt("████████░░░░ 67% complete")).toBe(false);
  });

  test("generic success message", () => {
    expect(detectPrompt("✓ All tests passed (42 specs)")).toBe(false);
  });
});

// ── Real-world agent prompt patterns ──

describe("prompt classifier — real-world agent prompts", () => {
  test("Claude code: permission request", () => {
    expect(
      detectPrompt(
        "Claude wants to edit src/index.ts\nDo you want to approve this action? (y/n)"
      )
    ).toBe(true);
  });

  test("npm init: continue?", () => {
    expect(detectPrompt("Is this OK? (yes/no)")).toBe(true);
  });

  test("git rebase: continue prompt", () => {
    expect(detectPrompt("Would you like to continue? [Y/n]")).toBe(true);
  });

  test("bun install: trust script", () => {
    expect(
      detectPrompt("Do you want to trust this postinstall script? [y/N]")
    ).toBe(true);
  });

  test("sudo: password prompt (no match expected)", () => {
    expect(detectPrompt("Password:")).toBe(false);
  });

  test("Python input() with custom prompt (no match expected)", () => {
    expect(detectPrompt("Enter your name: ")).toBe(false);
  });

  test("claude: waiting for response", () => {
    expect(detectPrompt("waiting for response from user")).toBe(true);
  });
});
