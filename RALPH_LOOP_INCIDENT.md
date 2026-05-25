# ralph loop incident — codex + srt + transcript subtask blow-up

## summary

ralph originally failed because `agent: codex` was run under `sandbox: srt`, but the srt settings only allowed writes to the worktree, `/tmp`, and `~/.claude`. codex needs writable state under `~/.codex`, so startup failed with a misleading ownership-style error:

```text
Codex cannot access session files at /Users/home/.codex/sessions (permission denied)
```

outside srt, `~/.codex/sessions` was writable, so ownership was not the root cause. the sandbox denied it.

## quick local mitigation attempted

we reran the same ralph loop with:

```text
--agent codex
--sandbox false
--worktree plan
--worktree-branch edc-triage
```

this confirmed the sandbox was the immediate blocker: `.ralph.log` showed `sandbox: off`, codex started successfully, and iteration 1 completed.

## what went wrong next

once codex was allowed to run, ralph went runaway.

root cause: ralph parses subtasks from raw agent stdout using a fragile text regex:

```ts
/<subtasks>([\s\S]*?)<\/subtasks>/
```

codex echoes the full prompt/transcript to stdout. the ralph prompt itself contains literal `<subtasks>` instructions, and later codex printed source/test content containing `</subtasks>`. ralph interpreted the giant transcript span between those markers as a real subtask block.

result:

- ralph appended thousands of bogus `- [ ] ...` checkbox tasks into `PLAN-edc-report-triage.md`
- it logged `subtasks added: 5103`
- iteration budget expanded from `5` to the ceiling `100`
- ralph started executing garbage tasks from transcript/source text, e.g. `interface RalphStatus {` and `project: string;`
- the root plan file was also corrupted because shutdown synced the worktree plan back to the project root

## shutdown behavior observed

we sent `SIGTERM`, then `SIGINT`. ralph logged shutdown and removed the lock, but the active iteration still completed after shutdown began and marked another bogus task done before process exit.

so there is a second bug: signal handling sets `stopping`, but the active `runIteration()` close path can still continue the main loop's post-iteration completion logic.

## final observed state

- ralph process stopped
- `.ralph.lock` removed
- root git status only showed untracked local notes/plans:
  - `AGENTS.md`
  - `RALPH_CODEX_SRT_FIX_PLAN.md`
- `PLAN-edc-report-triage.md` in root was corrupted with bogus checkbox subtasks
- `.worktrees/edc-triage` was clean but had many commits from the runaway loop
- latest observed branch head in that worktree: `76a7d30 make project directory configurable`

## actual issues to fix

1. make srt settings agent-aware
   - codex needs write access to minimal `~/.codex` state paths
   - codex needs network domains like `chatgpt.com` / `*.chatgpt.com`
   - current sandbox config is claude-shaped only

2. stop parsing subtasks from raw transcript stdout
   - current `<subtasks>...</subtasks>` regex is string-as-protocol on human/log output
   - codex transcript echo makes it unsafe
   - fix should parse a structured final answer if available, or use a channel/file/protocol that cannot be confused with echoed prompt text

3. harden shutdown
   - after `SIGTERM`/`SIGINT`, active iteration close must not mark tasks done, append subtasks, expand budget, sync corrupted plans, or continue loop cleanup as if successful

4. add regression tests
   - codex/srt settings include required codex paths/domains
   - subtask parser ignores echoed prompt/transcript markers
   - shutdown during active iteration does not mark progress or mutate plan after stop begins
