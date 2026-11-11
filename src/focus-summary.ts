import { focusLastLine } from "./focus-text.js";

// Same Pi token/context grammar as the observer's display projection, extended
// to counters-only footers. This is display filtering, never runtime evidence.
const PI_STATS = /^(?:[↑↓RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%|\$\d+(?:\.\d+)?|\(sub\)|(?:\d+(?:\.\d+)?%|\?)\s*\/\d+(?:\.\d+)?[kM]?)(?=\s|$)/;
const RULE = /^[\s\u2500-\u257f─—-]+$/u;
const EMPTY_PROMPT = /^[›>❯$▏▎▍▌▋▊▉█│┃]+$/u;
const PI_STATUS = /^(?:[─—-]+\s*)?[⠁-⣿]\s+(?:Working|Thinking|Compacting|Running|Waiting)\b/iu;
const CLAUDE_CHROME = /^(?:(?:Opus|Sonnet|Haiku)\s+[\d.]+\s*\|.*\b(?:tokens|ctx)\b|\/clear to save\b|⏵⏵ auto mode on \(shift\+tab to cycle\)|✔ Update installed · \/restart to apply|[✻✽✶✳✢·]\s+(?:Working|Thinking|Compacting|Running|Waiting|Cooked|Worked)\b)/iu;

/** Last meaningful visible rows, not authenticated agent text or a transcript.
 * Only Pi and Claude have supported chrome; other harnesses stay untouched. */
export function focusSummary(rows: readonly string[], harness: string): string[] {
  if (harness !== "pi" && harness !== "claude") return [];
  let lines = rows.map(focusLastLine).filter(Boolean);
  if (harness === "pi") {
    // Pi's cwd/stats/extension statuses form one footer block. Drop statuses
    // after the stats too (including git errors), but keep errors in the body.
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      if (!PI_STATS.test(lines[i]!)) continue;
      const start = i > 0 && /^(?:~\/|\/|…)/u.test(lines[i - 1]!) ? i - 1 : i;
      lines = lines.slice(0, start);
      break;
    }
  }
  let meaningful: string[] = [];
  for (let line of lines) {
    if (RULE.test(line) || EMPTY_PROMPT.test(line)) continue;
    if (harness === "pi") {
      if (PI_STATS.test(line) || PI_STATUS.test(line)
        || /^Update available: \S+ → \S+$/u.test(line)
        || /^Run .+pi-coding-agent.* to update\.$/u.test(line)) continue;
    } else {
      if (CLAUDE_CHROME.test(line)) continue;
      if (/^[❯›]\s+\S/u.test(line)) { meaningful = []; continue; }
      if (/^●\s/u.test(line)) { meaningful = []; line = line.replace(/^●\s+/u, ""); }
    }
    meaningful.push(line);
  }
  // Keep the question at the end when a long visible message exceeds budget.
  const summary: string[] = [];
  let remaining = 600;
  for (const line of meaningful.slice(-4).reverse()) {
    const text = Array.from(line).slice(-remaining).join("");
    if (!text || remaining <= 0) break;
    summary.unshift(text);
    remaining -= Array.from(text).length + 1;
  }
  return summary;
}
