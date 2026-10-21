import { describe, expect, test } from "bun:test";
import * as observation from "../../src/server/session-observation";
const { lastTerminalPreviewLine } = observation;
const terminalDisplayProjection: typeof observation.terminalDisplayProjection = (...args) => observation.terminalDisplayProjection(...args);
import { sessionTier } from "../../src/agent-runtime-ui";

import { PI_FOOTER as pi } from "../fixtures/pi-footer";
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
    ["$0.000 (sub) 0.0%/272k (auto)                            (openai-codex) gpt-6.1-sol • high", 0, 272000],
    ["0.0%/272k (auto)                            gpt-6.1-sol • high", 0, 272000],
    ["?/1.0M (auto)                            gpt-6.1-sol • high", undefined, 1000000],
    ["0.0%/272 (auto)                            gpt-6.1-sol • high", 0, 272],
  ] as const)("fresh pi footer without token counters: %s", (footer, contextPct, contextLimit) => {
    for (const status of ["", "\npi-tasks: idle"]) {
      const projection = terminalDisplayProjection(`Ready for your request\n~/project\n${footer}${status}`);
      expect(projection.lastLine).toBe("Ready for your request");
      expect(projection.footer).toBe(footer);
      expect(projection.meta?.model).toBe("gpt-6.1-sol");
      expect(projection.meta?.reasoning).toBe("high");
      expect(projection.meta?.contextPct).toBe(contextPct);
      expect(projection.meta?.contextLimit).toBe(contextLimit);
    }
  });
  test.each([
    "lines 85%/90 met",
    "coverage 85%/90",
    "progress 85%/90k met",
    "progress 85%/1.0M met",
    "report ?/272k pending",
  ])("non-pi context-like prose is not a footer: %s", (line) => {
    expect(terminalDisplayProjection(`Coverage report\n${line}\n$`)).toEqual({ lastLine: "$" });
    expect(terminalDisplayProjection(`Coverage report\n${line}`)).toEqual({ lastLine: line });
  });
  test("pi stats prefixes include cache writes and zero cost", () => {
    const footer = "↑1.2k ↓3 R4.0M W5 CH99.7% $0.000 (sub) 0.0%/272k (auto)    gpt-4.1";
    expect(terminalDisplayProjection(`Agent answer\n~/project\n${footer}\npi-tasks: idle`)).toEqual({
      lastLine: "Agent answer", footer,
      meta: { model: "gpt-4.1", contextPct: 0, contextLimit: 272000, cost: 0, costTag: "sub" },
    });
  });
  test.each(["↑3 items moved", "↓3 items moved"])("non-pi arrow output is not a footer: %s", (line) => {
    expect(terminalDisplayProjection(`line one\n${line}\nprompt>`)).toEqual({ lastLine: "prompt>" });
    expect(terminalDisplayProjection(`line one\n${line}`)).toEqual({ lastLine: line });
  });
  test.each([
    "~/x", "~/x (b) • named-session", "/srv/project (b)", "…/long/project (b)",
  ])("pi footer block skips adjacent cwd: %s", (cwd) => {
    for (const suffix of ["", "\npi-tasks outbox failure", "\nstatus one\nstatus two"]) {
      const projection = terminalDisplayProjection(`Agent answer\n${cwd}\n${pi}${suffix}\n`);
      expect(projection.lastLine).toBe("Agent answer");
      expect(projection.footer).toBe(pi);
      expect(projection.meta?.model).toBe("gpt-6-astra");
    }
  });
  test.each(["pi-tasks outbox failure", "status one\nstatus two"])("pi footer block skips trailing status: %s", (status) => {
    const projection = terminalDisplayProjection(`Agent answer\n~/dev/wolfpack (branch)\n${pi}\n${status}`);
    expect(projection.lastLine).toBe("Agent answer");
    expect(projection.footer).toBe(pi);
    expect(projection.meta?.model).toBe("gpt-6-astra");
  });
  test("pi footer anchoring is bounded and preserves ordinary text next to stats", () => {
    expect(lastTerminalPreviewLine(`Agent answer\n${pi}`)).toBe("Agent answer");
    expect(lastTerminalPreviewLine(`Earlier\n~/x\n${pi}\none\ntwo\nActual agent answer`)).toBe("Actual agent answer");
    expect(lastTerminalPreviewLine("Earlier\n/srv/project (b)")).toBe("/srv/project (b)");
  });
  test("pi million-token windows use M, not k", () => {
    expect(terminalDisplayProjection(`Answer\n${pi.replace("40.3%/272k", "12.0%/1.0M")}`).meta).toMatchObject({ contextPct: 12, contextLimit: 1000000 });
  });
  test.each([
    ["gpt-6-astra • medium", "medium"],
    ["gpt-6-astra • thinking off", "thinking off"],
    ["(openai-codex) gpt-6-astra • thinking off", "thinking off"],
  ])("pi optional provider and multiword reasoning: %s", (model, reasoning) => {
    const footer = pi.replace(" (auto)", "").replace("(openai-codex) gpt-6-astra • medium", model);
    expect(terminalDisplayProjection(`Answer\n${footer}`).meta).toMatchObject({ model: "gpt-6-astra", reasoning });
  });
  test.each([
    ["gpt-4.1", { model: "gpt-4.1" }],
    ["(openai) gpt-4.1", { model: "gpt-4.1" }],
    ["auto → gpt-6.1-sol • high", { model: "gpt-6.1-sol", reasoning: "high" }],
    ["(router) auto → (openai) gpt-4.1", { model: "gpt-4.1" }],
    ["auto → fallback → gpt-6.1-sol • thinking off", { model: "gpt-6.1-sol", reasoning: "thinking off" }],
  ])("pi non-reasoning and routed models: %s", (label, expected) => {
    const footer = pi.replace("(openai-codex) gpt-6-astra • medium", label);
    const meta = terminalDisplayProjection(`Answer\n${footer}`).meta;
    expect(meta?.model).toBe(expected.model);
    expect(meta?.reasoning).toBe("reasoning" in expected ? expected.reasoning : undefined);
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
  test("preserves unrecognized counter text as content, not pi chrome", () => {
    expect(terminalDisplayProjection("Answer\n↑12k ↓3k unknown-footer")).toEqual({ lastLine: "↑12k ↓3k unknown-footer" });
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
