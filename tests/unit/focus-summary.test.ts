import { describe, expect, test } from "bun:test";
import { focusSummary } from "../../src/focus-summary.ts";

// Screen-row fixtures retain the reported Pi/Claude chrome shapes. Message text
// is synthetic: no operator session or provider conversation is read by tests.
const screens = [
  {
    name: "pi token/cost footer without context",
    harness: "pi",
    screen: "The approved plan is ready.\nShall I proceed?\n──────────────────\n❯\n──────────────────\n~/dev/app (main)\n↑114k ↓21k R2.1M $4.396 (sub)",
    expected: ["The approved plan is ready.", "Shall I proceed?"],
  },
  {
    name: "pi working status and spinner",
    harness: "pi",
    screen: "The checks passed.\nContinue with the approved next step?\n── ⠴ Working ──\n>\n↑114k ↓21k 54%/200k  gpt-6.1-sol • high",
    expected: ["The checks passed.", "Continue with the approved next step?"],
  },
  {
    name: "pi update banner",
    harness: "pi",
    screen: "Update available: 1.2.0 → 1.3.0\nRun npm install -g @mariozechner/pi-coding-agent to update.\nThe implementation is ready.\nShould I start the tests?\n──────────────────\n>\n? /200k",
    expected: ["The implementation is ready.", "Should I start the tests?"],
  },
  {
    name: "pi git footer error, not an actual message error",
    harness: "pi",
    screen: "fatal: not a git repository (or any of the parent directories): .git\nThat command failed in the scratch folder.\nMay I continue in the project folder?\n──────────────────\n>\n/tmp/scratch\n↑114k ↓21k $4.396 (sub)\nfatal: not a git repository (or any of the parent directories): .git",
    expected: ["fatal: not a git repository (or any of the parent directories): .git", "That command failed in the scratch folder.", "May I continue in the project folder?"],
  },
  {
    name: "claude model status, prompt and clear hint",
    harness: "claude",
    screen: "● The plan is approved.\n  Shall I implement the first step?\n──────────────────\n❯\n──────────────────\nOpus 5.5 | tokens 32k | ctx 18%\n/clear to save context",
    expected: ["The plan is approved.", "Shall I implement the first step?"],
  },
  {
    name: "claude spinner, update and auto-mode footer",
    harness: "claude",
    screen: "● Ready for the next step.\n  Go ahead with the approved scope?\n✻ Working…\n❯\n⏵⏵ auto mode on (shift+tab to cycle)\n✔ Update installed · /restart to apply",
    expected: ["Ready for the next step.", "Go ahead with the approved scope?"],
  },
  {
    name: "claude newest multi-line question without the earlier exchange",
    harness: "claude",
    screen: "● Earlier answer.\n❯ Prepare the approved rollout.\n● The rollout is prepared.\n  Tests passed; nothing has been deployed.\n  I can continue with the approved local checks.\n  Shall I go ahead?\n❯\nOpus 5.5 | tokens 44k | ctx 21%",
    expected: ["The rollout is prepared.", "Tests passed; nothing has been deployed.", "I can continue with the approved local checks.", "Shall I go ahead?"],
  },
  {
    name: "pi chrome only is empty, not a successful finish",
    harness: "pi",
    screen: "──────────────────\n── ⠴ Working ──\n>\n~/dev/app (main)\n↑114k ↓21k $4.396 (sub)",
    expected: [],
  },
];

describe("bounded focus summary", () => {
  for (const fixture of screens) {
    test(fixture.name, () => expect(focusSummary(fixture.screen.split("\n"), fixture.harness)).toEqual(fixture.expected));
  }
  const piFooter = ["──────────────────", "❯", "──────────────────", "~/dev/app (main)", "↑114k ↓21k 54%/200k  gpt-6.1-sol • high"];
  const claudeFooter = ["──────────────────", "❯", "──────────────────", "Opus 5.5 | tokens 32k | ctx 18%"];
  for (const body of [
    ["The approved plan is ready.", "$5 per day is the limit; may I proceed?"],
    ["R2 still fails on iphone-se", "W1 flaky retry", "$12 per month extra…", "Shall I proceed?"],
    ["↑3 files staged, ready", "Shall I proceed?"],
  ]) {
    test(`pi preserves stats-like prose with a real footer: ${body[0]}`, () => {
      expect(focusSummary([...body, ...piFooter], "pi")).toEqual(body);
    });
  }
  for (const body of [
    ["The local change is ready.", "$5 per day is the estimate.", "May I proceed?"],
    ["R2 is ready for review", "Shall I merge?"],
    ["$5", "R2", "W1", "↑3"],
  ]) {
    test(`pi never cuts body rows without a footer: ${body[0]}`, () => {
      expect(focusSummary(body, "pi")).toEqual(body);
    });
  }
  test("pi preserves whole stats-token body rows above the input region", () => {
    const body = ["$5", "R2", "W1", "↑3"];
    expect(focusSummary([...body, ...piFooter], "pi")).toEqual(body);
  });
  for (const input of ["❯ yes but first run the", '❯ Try "refactor <filepath>"']) {
    test(`claude skips the bottom input row without clearing the message: ${input}`, () => {
      expect(focusSummary(["● The plan is approved.", "  Shall I implement the first step?", "──────────────────", input, "──────────────────", "Opus 5.5 | tokens 32k | ctx 18%"], "claude"))
        .toEqual(["The plan is approved.", "Shall I implement the first step?"]);
    });
  }
  test("claude preserves indented command examples inside the message", () => {
    expect(focusSummary(["● Which local command should I run?", "  ❯ bun test", "  ❯ bun run typecheck", ...claudeFooter], "claude"))
      .toEqual(["Which local command should I run?", "❯ bun test", "❯ bun run typecheck"]);
  });
  test("claude selects the new assistant block after a real user turn", () => {
    expect(focusSummary(["● Earlier answer.", "❯ Prepare the local checks.", "● Ready. Shall I proceed?", ...claudeFooter], "claude"))
      .toEqual(["Ready. Shall I proceed?"]);
  });
  test("keeps the last four rows in reading order", () => {
    expect(focusSummary(["one", "two", "three", "four", "five", ">"], "pi")).toEqual(["two", "three", "four", "five"]);
  });
  test("strips the same control/bidi/invisible data as lastLine", () => {
    expect(focusSummary(["ask\u0007 \u202e\u2066\u200b\ufeffnow?", ">"], "pi")).toEqual(["ask now?"]);
  });
  test("bounds total text to 600 code points, preserving the end of the question", () => {
    const summary = focusSummary(["old", "a".repeat(400), "b".repeat(400), "Proceed?"], "pi");
    expect(summary.length).toBeLessThanOrEqual(4);
    expect(Array.from(summary.join("\n")).length).toBeLessThanOrEqual(600);
    expect(summary.at(-1)).toBe("Proceed?");
    expect(summary.every(line => Array.from(line).length <= 300)).toBe(true);
  });
  test("does not project other harnesses", () => {
    for (const harness of ["shell", "custom", "codex", "gemini", "cursor"]) expect(focusSummary(["message"], harness)).toEqual([]);
  });
});
