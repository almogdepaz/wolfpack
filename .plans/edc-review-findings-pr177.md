# pr #177 edc findings remediation

## status
- branch: `fix/162-ralph-configured-agents`
- base head: `a27ebcc77613e65a3e9b86cb3cce57b8d52dccd8`
- worktree: `/private/tmp/wolfpack-pr177-findings`
- current item: complete
- constraints: regression first; continuous execution authorized; no commit, merge, or push

## findings
- [x] b1. use HTML-attribute-safe rendering for Ralph project options and cover hostile project names in a browser
- [x] b2. make configured-agent provenance explicit: missing/empty persisted settings must not silently become configured built-ins; cover route and browser behavior

## verification ledger

### b1 — project option attribute escaping
- history: PR head `a27ebcc` changed plain project-option values from HTML escaping to `escAttr`, which is specifically a JavaScript-string-in-attribute escaper and backslash-escapes quotes after HTML decoding.
- red: a real Chromium regression parsed `quote\" data-injected=\"yes` as value `quote\\`, proving attribute breakout.
- implementation: restore `esc()` for the plain HTML value attribute; labels remain text-escaped.
- focused green: desktop Playwright Ralph picker regression — 1 passed, 0 failed.

### b2 — persisted configured-agent authority
- decision: Ralph authorization requires persisted command configuration. Session-picker defaults may still be synthesized for a fresh install, but they do not authorize Ralph.
- red: missing and explicitly empty settings both advanced past authorization using synthesized built-ins; Chromium rendered `claude` and `codex` despite an empty authoritative Ralph-agent list.
- implementation: settings loading now returns session settings plus Ralph agents derived only from persisted `cmds` or explicit legacy `customCmds`; persisted empty arrays stay empty. GET/POST settings expose `effective.ralphAgents`, the browser consumes that authority, and start authorization uses the same source.
- focused green: settings/Ralph/schema/API suites — 127 passed, 0 failed; desktop Chromium picker regressions — 2 passed, 0 failed.
- generated assets, control API artifact, and schema snapshot refreshed.
- Rust full green: 167 passed, 0 failed.
- TypeScript full green after broker build: `bun test --max-concurrency 8` — 1,653 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.
