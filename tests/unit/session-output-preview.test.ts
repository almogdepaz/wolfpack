import { describe, expect, test } from "bun:test";
import * as observation from "../../src/server/session-observation";
const { lastTerminalPreviewLine } = observation;
const terminalDisplayProjection: typeof observation.terminalDisplayProjection = (...args) => observation.terminalDisplayProjection(...args);
import { sessionTier } from "../../src/agent-runtime-ui";

const pi = "↑716k ↓88k R32M CH99.7% $42.822 (sub) 40.3%/272k (auto)                            (openai-codex) gpt-6-astra • medium";
const piSmall = "↑9.8k ↓39 $0.020 (sub) 2.0%/500k (auto)                                              (openai-codex) gpt-6.1-sol • medium";

describe("display-only terminal projection", () => {
  test("skips real pi footer and path; CH is not context", () => {
    expect(lastTerminalPreviewLine(`Agent answer\n${pi}`)).toBe("Agent answer");
    expect(terminalDisplayProjection(`Agent answer\n~/dev/wolfpack (ui/apple-reskin)\n${pi}\n`)).toEqual({
      lastLine: "Agent answer", footer: pi,
      meta: { model: "gpt-6-astra", reasoning: "medium", contextPct: 40.3, contextLimit: 272000, cost: 42.822, costTag: "sub" },
    });
    expect(terminalDisplayProjection(`Answer\n${piSmall}`).meta).toEqual({ model: "gpt-6.1-sol", reasoning: "medium", contextPct: 2, contextLimit: 500000, cost: 0.02, costTag: "sub" });
    expect(terminalDisplayProjection("Answer\n↑1k CH99.7%").meta).toBeUndefined();
  });
  test.each([
    "⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
    "⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent",
    "✔ Update installed · /restart to apply",
  ])("skips captured claude chrome: %s", (footer) => {
    expect(terminalDisplayProjection(`Claude answer\n${footer}\n────────────\n❯ `)).toEqual({ lastLine: "Claude answer", footer });
  });
  test("uncaptured harnesses skip only obvious chrome, without inventing metadata", () => {
    // Synthetic codex/gemini/cursor chrome: no claim of live footer capture.
    for (const harness of ["codex", "gemini", "cursor"]) {
      expect(terminalDisplayProjection(`${harness} answer\n└─────────┘\n> `)).toEqual({ lastLine: `${harness} answer` });
    }
  });
  test("preserves unknown footer text for fallback rendering", () => {
    expect(terminalDisplayProjection("Answer\n↑12k ↓3k unknown-footer")).toEqual({ lastLine: "Answer", footer: "↑12k ↓3k unknown-footer" });
  });
  test("bounds agent line to 160 codepoints and sanitizes controls", () => {
    expect(lastTerminalPreviewLine("first\n final status ")).toBe("final status");
    expect(lastTerminalPreviewLine("ok\u0007bad")).toBe("okbad");
    expect(Array.from(lastTerminalPreviewLine("😀".repeat(500)))).toHaveLength(160);
  });
  test("retains old final-line fallback (240 chars) when only chrome remains", () => {
    expect(lastTerminalPreviewLine(undefined)).toBe("");
    expect(lastTerminalPreviewLine("────────────")).toBe("────────────");
    expect(lastTerminalPreviewLine(`${pi}\n`)).toBe("");
    expect(lastTerminalPreviewLine("─".repeat(500))).toHaveLength(240);
  });
  test("a y/n preview cannot override the runtime-provided Done tier", () => {
    const projection = terminalDisplayProjection(`Do you want to continue? (y/n)\n${pi}`);
    expect(projection.lastLine).toBe("Do you want to continue? (y/n)");
    expect(sessionTier({ ...projection, runtimeState: { state: "done", freshness: "fresh", stale: false, authority: "program", source: "program-status" } })).toBe("idle");
  });
});
