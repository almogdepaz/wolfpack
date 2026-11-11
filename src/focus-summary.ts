import { AGENT_KIND } from "./agent-kind.js";
import { focusLastLine } from "./focus-text.js";

// Whole Pi stats rows, with an optional model/reasoning status after the
// double-space separator. This is display filtering, never runtime evidence.
const PI_STATS = /^(?:(?:[↑↓RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%|\$\d+(?:\.\d+)?|\(sub\)|(?:\d+(?:\.\d+)?%|\?)\s*\/\d+(?:\.\d+)?[kM]?)\s*)+(?:\s{2,}(?:\([\w-]+\)\s+)?[\w.-]+(?:\s+•\s+\w+(?:\s+\w+)*)?)?$/;
const RULE = /^[\s\u2500-\u257f─—-]+$/u;
const EMPTY_PROMPT = /^[›>❯$▏▎▍▌▋▊▉█│┃]+$/u;
const PI_STATUS = /^(?:[─—-]+\s*)?[⠁-⣿]\s+(?:Working|Thinking|Compacting|Running|Waiting)\b/iu;
const CLAUDE_CHROME = /^(?:(?:Opus|Sonnet|Haiku)\s+[\d.]+\s*\|.*\b(?:tokens|ctx)\b|\/clear to save\b|⏵⏵ auto mode on \(shift\+tab to cycle\)|✔ Update installed · \/restart to apply|[✻✽✶✳✢·]\s+(?:Working|Thinking|Compacting|Running|Waiting|Cooked|Worked)\b)/iu;

/** Last meaningful visible rows, not authenticated agent text or a transcript.
 * Only Pi and Claude have supported chrome; other harnesses stay untouched. */
export function focusSummary(rows: readonly string[], harness: string): string[] {
  if (harness !== AGENT_KIND.PI.id && harness !== AGENT_KIND.CLAUDE.id) return [];
  let lines = rows.map(focusLastLine).filter(Boolean);
  if (harness === AGENT_KIND.PI.id) {
    // Only the bottom input/footer block may contain removable stats. Body
    // tokens and cost-bearing prose must survive, even without any footer.
    const inputIndex = lines.findLastIndex(line => EMPTY_PROMPT.test(line));
    if (inputIndex >= 0) {
      for (let i = lines.length - 1; i >= Math.max(inputIndex + 1, lines.length - 6); i--) {
        if (!PI_STATS.test(lines[i]!)) continue;
        const start = i > 0 && /^(?:~\/|\/|…)/u.test(lines[i - 1]!) ? i - 1 : i;
        lines = lines.slice(0, start);
        break;
      }
    }
  } else {
    // A draft/placeholder in the final ruled input region is chrome, not a
    // submitted user turn. Prompt-like command examples elsewhere are prose.
    const bottomRule = lines.findLastIndex(line => RULE.test(line));
    const topRule = lines.findLastIndex((line, index) => index < bottomRule && RULE.test(line));
    const inputIndex = lines.findLastIndex((line, index) => index > topRule && index < bottomRule && /^[❯›](?:\s|$)/u.test(line));
    if (topRule >= 0 && inputIndex >= 0) lines = lines.filter((_, index) => index !== inputIndex);
  }
  let meaningful: string[] = [];
  for (let line of lines) {
    if (RULE.test(line) || EMPTY_PROMPT.test(line)) continue;
    if (harness === AGENT_KIND.PI.id) {
      if (PI_STATUS.test(line)
        || /^Update available: \S+ → \S+$/u.test(line)
        || /^Run .+pi-coding-agent.* to update\.$/u.test(line)) continue;
    } else {
      if (CLAUDE_CHROME.test(line)) continue;
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
