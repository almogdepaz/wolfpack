// Inline command snippet classifier — detects error patterns in terminal output
// and suggests likely next commands. Pure function, no side effects.

export interface Snippet {
  label: string;
  command: string;
}

interface Rule {
  pattern: RegExp;
  snippets: Snippet[];
}

const RULES: Rule[] = [
  // ── npm errors ──
  {
    pattern: /npm ERR!/,
    snippets: [
      { label: "npm ci", command: "npm ci" },
      { label: "npm install", command: "npm install" },
    ],
  },
  {
    pattern: /npm warn|ERESOLVE/,
    snippets: [
      { label: "npm install --force", command: "npm install --force" },
    ],
  },
  {
    pattern: /Cannot find module/,
    snippets: [
      { label: "npm install", command: "npm install" },
      { label: "bun install", command: "bun install" },
    ],
  },
  // ── bun errors ──
  {
    pattern: /bun (?:install|add|run).*error|error:.*bun|ModuleNotFound/i,
    snippets: [
      { label: "bun install", command: "bun install" },
    ],
  },
  {
    pattern: /bunfig\.toml|bun\.lockb/i,
    snippets: [
      { label: "bun install", command: "bun install" },
    ],
  },
  // ── git conflicts ──
  {
    pattern: /CONFLICT \(|Merge conflict|both modified:|Unmerged paths/i,
    snippets: [
      { label: "git status", command: "git status" },
      { label: "git diff", command: "git diff" },
    ],
  },
  {
    pattern: /You have unmerged paths|fix conflicts and run/i,
    snippets: [
      { label: "git status", command: "git status" },
      { label: "git diff", command: "git diff" },
      { label: "git merge --abort", command: "git merge --abort" },
    ],
  },
  {
    pattern: /rebase in progress|interactive rebase in progress/i,
    snippets: [
      { label: "git rebase --continue", command: "git rebase --continue" },
      { label: "git rebase --abort", command: "git rebase --abort" },
    ],
  },
  // ── git push/pull ──
  {
    pattern: /Updates were rejected|failed to push some refs/i,
    snippets: [
      { label: "git pull", command: "git pull" },
      { label: "git pull --rebase", command: "git pull --rebase" },
    ],
  },
  {
    pattern: /Your branch is behind/i,
    snippets: [
      { label: "git pull", command: "git pull" },
    ],
  },
  {
    pattern: /not a git repository/i,
    snippets: [
      { label: "git init", command: "git init" },
    ],
  },
  // ── python errors ──
  {
    pattern: /ModuleNotFoundError: No module named '([^']+)'/,
    snippets: [
      { label: "pip install", command: "pip install" },
    ],
  },
  {
    pattern: /ImportError:|ModuleNotFoundError/,
    snippets: [
      { label: "pip install -r requirements.txt", command: "pip install -r requirements.txt" },
    ],
  },
  {
    pattern: /No such file.*venv|virtualenv/i,
    snippets: [
      { label: "python -m venv venv", command: "python -m venv venv" },
    ],
  },
  // ── permission denied ──
  {
    pattern: /Permission denied/i,
    snippets: [
      { label: "sudo !!", command: "sudo !!" },
      { label: "chmod +x", command: "chmod +x " },
    ],
  },
  {
    pattern: /EACCES/,
    snippets: [
      { label: "sudo !!", command: "sudo !!" },
    ],
  },
  // ── docker ──
  {
    pattern: /Cannot connect to the Docker daemon/i,
    snippets: [
      { label: "docker info", command: "docker info" },
    ],
  },
  {
    pattern: /No such container/i,
    snippets: [
      { label: "docker ps -a", command: "docker ps -a" },
    ],
  },
  // ── rust / cargo ──
  {
    pattern: /error\[E\d+\]|cargo build.*failed/i,
    snippets: [
      { label: "cargo check", command: "cargo check" },
      { label: "cargo build", command: "cargo build" },
    ],
  },
  // ── typescript / tsc ──
  {
    pattern: /TS\d{4}:|error TS/,
    snippets: [
      { label: "npx tsc --noEmit", command: "npx tsc --noEmit" },
    ],
  },
  // ── port in use ──
  {
    pattern: /EADDRINUSE|address already in use/i,
    snippets: [
      { label: "lsof -i :PORT", command: "lsof -i :" },
    ],
  },
  // ── disk / memory ──
  {
    pattern: /No space left on device|ENOSPC/i,
    snippets: [
      { label: "df -h", command: "df -h" },
    ],
  },
  {
    pattern: /ENOMEM|out of memory|JavaScript heap/i,
    snippets: [
      { label: "free -h", command: "free -h" },
    ],
  },
  // ── test failures ──
  {
    pattern: /(\d+) (?:tests?|specs?) failed|FAIL(?:ED)?.*test/i,
    snippets: [
      { label: "rerun tests", command: "bun test" },
    ],
  },
];

// How many trailing lines to scan (keeps it fast on large panes)
const SCAN_LINES = 20;

/**
 * Classify terminal pane text and return suggested command snippets.
 * Returns at most `max` unique snippets. First-match-wins per command.
 */
export function classifySnippets(pane: string, max = 4): Snippet[] {
  if (!pane) return [];
  const lines = pane.trimEnd().split("\n").slice(-SCAN_LINES);
  const tail = lines.join("\n");

  const seen = new Set<string>();
  const result: Snippet[] = [];

  for (const rule of RULES) {
    if (result.length >= max) break;
    if (rule.pattern.test(tail)) {
      for (const s of rule.snippets) {
        if (result.length >= max) break;
        if (!seen.has(s.command)) {
          seen.add(s.command);
          result.push(s);
        }
      }
    }
  }
  return result;
}
