import { AGENT_KIND } from "./agent-kind.js";
import { focusLastLine } from "./focus-text.js";

// Whole Pi stats rows, with an optional model/reasoning status after the
// double-space separator. This is display filtering, never runtime evidence.
const PI_STATS = /^(?:(?:[↑↓RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%|\$\d+(?:\.\d+)?|\((?:sub|auto)\)|(?:\d+(?:\.\d+)?%|\?)\s*\/\d+(?:\.\d+)?[kM]?)\s*)+(?:\s{2,}(?:\([\w-]+\)\s+)?[\w.-]+(?:\s+•\s+\w+(?:\s+\w+)*)?)?$/;
const RULE = /^[\s\u2500-\u257f─—-]+$/u;
const EMPTY_PROMPT = /^[›>❯$▏▎▍▌▋▊▉█│┃]+$/u;
const PI_STATUS = /^(?:[─—-]+\s*)?[⠁-⣿]\s+(?:Working|Thinking|Compacting|Running|Waiting)\b/iu;
const CLAUDE_STATUS = /^(?:[✻✽✶✳✢·]\s+[a-z]+(?:…|\.{3})(?:\s.*)?|(?:[✻✽✶✳✢·]\s+)?[a-z]+ for (?:\d+h )?(?:\d+m )?\d+s)$/iu;
// Tool blocks share the message bullet, but their function-call header and output
// are not an assistant message. Keep the preceding message until the next one.
const CLAUDE_TOOL = /^●\s+(?:[A-Z]\w*|mcp__\w+)\(/u;
const CLAUDE_CHROME = /^(?:(?:Opus|Sonnet|Haiku)\s+[\d.]+\s*\|.*\b(?:tokens|ctx)\b|\/clear to save\b|⏵⏵ auto mode on \(shift\+tab to cycle\)|✔ Update installed · \/restart to apply|[✻✽✶✳✢·]\s+(?:Working|Thinking|Compacting|Running|Waiting|Cooked|Worked)\b)/iu;

/** Last meaningful visible rows, not authenticated agent text or a transcript.
 * Only Pi and Claude have supported chrome; other harnesses stay untouched. */
export function focusSummary(rows: readonly string[], harness: string): string[] {
  if (harness !== AGENT_KIND.PI.id && harness !== AGENT_KIND.CLAUDE.id) return [];
  let lines = rows.map(focusLastLine).filter(Boolean);
  if (harness === AGENT_KIND.PI.id) {
    // The startup update notice is a bounded box, not arbitrary update prose.
    for (let i = 0; i + 4 < lines.length; i++) {
      if (RULE.test(lines[i]!) && lines[i + 1] === "Update Available"
        && /^New version \S+ is available\. Run pi update$/u.test(lines[i + 2]!)
        && lines[i + 3] === "Changelog: https://pi.dev/changelog" && RULE.test(lines[i + 4]!)) {
        lines.splice(i, 5);
        i--;
      }
    }
    // Pi 1.x has a ruled editor without a prompt glyph. Require cwd/stats
    // below its rule before removing that footer and any stray editor stderr.
    // Stats-like body prose without either input/footer shape stays visible.
    const inputIndex = lines.findLastIndex(line => EMPTY_PROMPT.test(line));
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      if (!PI_STATS.test(lines[i]!)) continue;
      let start = i > 0 && /^(?:~\/|\/|…)/u.test(lines[i - 1]!) ? i - 1 : i;
      if (!(inputIndex >= 0 && i > inputIndex)) {
        if (start === i || !RULE.test(lines[start - 1] ?? "")) continue;
        while (start > 0 && RULE.test(lines[start - 1]!)) start--;
        if (start >= 2 && /^fatal: not a git repository\b/u.test(lines[start - 1]!) && RULE.test(lines[start - 2]!)) start -= 2;
      }
      lines = lines.slice(0, start);
      break;
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
  let claudeTool = false;
  for (let line of lines) {
    if (RULE.test(line) || EMPTY_PROMPT.test(line)) continue;
    if (harness === AGENT_KIND.PI.id) {
      if (PI_STATUS.test(line)
        || /^Update available: \S+ → \S+$/u.test(line)
        || /^Run .+pi-coding-agent.* to update\.$/u.test(line)) continue;
    } else {
      if (CLAUDE_CHROME.test(line) || CLAUDE_STATUS.test(line)) continue;
      if (/^●\s/u.test(line)) {
        claudeTool = CLAUDE_TOOL.test(line);
        if (!claudeTool) { meaningful = []; line = line.replace(/^●\s+/u, ""); }
      }
      if (claudeTool) continue;
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
