# wolfpack differential review — 2026-05-24

**target:** `fix/ralph-codex-srt` (`d585ac0`)
**baseline:** `main` (`git diff main...HEAD`, merge-base `ef18a86faded155208d98f3a9b5cb78f8bc3ffcf`)
**mode:** standalone edc-review
**strategy:** surgical/focused — large repo (2101 code files), high-risk ralph/sandbox paths reviewed deeply

## executive summary

| severity | count |
|----------|-------|
| 🔴 critical | 0 |
| 🟠 high | 0 |
| 🟡 medium | 1 |
| 🟢 low | 0 |

**overall risk:** medium  
**recommendation:** conditional — code direction is sound; add a worker-level regression test before merge.

**key metrics:**
- files changed: 26
- production files analyzed: 11/11 changed ts/rs files
- tests run during review: targeted unit suite, typecheck, broker-bin unit tests
- high-risk areas: ralph worker subprocess, srt sandbox policy, git metadata write scope, structured agent control channel
- known edc issues touched: no direct open issue fix/regression found; change intersects core fragility cluster “ralph agent containment”

## what changed

**commit range:** `main..HEAD`  
**commits:** 7 (`8edd81b` → `d585ac0`)  
**timeline:** 2026-05-19 to 2026-05-24

| file | + | - | risk | notes |
|------|---:|---:|------|-------|
| `src/ralph-macchio.ts` | 87 | 90 | high | replaces stdout tag parsing with response-file contract; changes agent invocation and sandbox settings use |
| `src/ralph-agent-command.ts` | 55 | 0 | high | codex/claude/gemini/cursor args; codex structured output flags |
| `src/ralph-response.ts` | 101 | 0 | medium | validates structured response JSON |
| `src/ralph-prompt.ts` | 64 | 0 | medium | prompt contract for response file |
| `src/validation.ts` | 39 | 2 | high | srt write/network policy widened for git metadata + codex |
| `src/ralph-git-exclude.ts` | 37 | 0 | medium | mutates `.git/info/exclude` to avoid transient commits |
| `src/wolfpack-context.ts` | 38 | 0 | medium | progress counting from `progress.txt` |
| `src/server/routes.ts` | 3 | 2 | medium | agent selection uses shared typed list |
| `src/server/shell.ts` | 5 | 3 | low | agent type extraction |
| `src/ralph-agent.ts` | 7 | 0 | low | shared agent enum |
| `broker/src/bin/wolfpack-broker.rs` | 81 | 4 | low | srt-specific bind failure explanation |

**total:** +1324 / -194 across 26 files.

## findings

### 🟡 medium: structured-response runner path lacks an end-to-end worker regression

**file:** `src/ralph-macchio.ts:L945-L985`  
**commit:** `9e4fa87` (`fix ralph structured agent responses`)  
**blast radius:** medium — all ralph iterations for all agents flow through `runIteration()` and response classification  
**test coverage:** partial

**description:**
The core behavior changed from parsing `<subtasks>` in stdout to requiring `.ralph-response.json`. Unit tests cover `buildAgentArgs()`, `parseRalphResponseJson()`, and prompt text, but no test executes the worker loop with a fake agent to prove the actual orchestration works: cwd selection, response path, pre-run cleanup, post-run classification, subtask append, and progress marking.

Current evidence:
- `tests/integration/ralph-api.test.ts` verifies `/api/ralph/start` spawn args only; it does not run `src/ralph-macchio.ts`.
- `runIteration()` is private, so the new path at `src/ralph-macchio.ts:L945-L985` is not directly covered.
- Targeted tests passed, but they are mostly unit seams around the orchestration rather than the orchestration itself.

**why it matters:**
A wrong response file path, cwd mismatch under worktree/task mode, or cleanup ordering bug would silently turn every successful agent run into “missing ralph response file” retries. That is a functional DoS of ralph loops, and the current tests would not catch it.

**attack/misuse scenario:**
1. authenticated user starts ralph with codex or claude.
2. agent completes the task and exits `0`.
3. runner looks for `.ralph-response.json` at the wrong cwd or after premature cleanup.
4. runner logs “missing ralph response file” and retries until iteration budget is exhausted.
5. user sees no completed progress despite successful agent work.

**recommendation:**
Add a worker-level regression that runs `src/ralph-macchio.ts` in a temp git repo with a fake agent binary on `PATH` that writes `.ralph-response.json`. Assert:
- `status: "done"` marks the task complete in `progress.txt`.
- `status: "needs_subtasks"` appends checkboxes and marks parent done.
- transient response/schema files are not staged by `git add -A`.
- at least one worktree mode (`--worktree plan` or `--worktree task`) resolves the response file from the active working dir.

## test coverage analysis

**coverage of changed behavior:** partial.

| area | status | evidence |
|------|--------|----------|
| response parser | covered | `tests/unit/ralph-response.test.ts` |
| agent arg builder | covered | `tests/unit/ralph-agent-command.test.ts` |
| git excludes | covered | `tests/unit/ralph-git-exclude.test.ts` |
| srt git/codex policy | covered | `tests/unit/ralph-sandbox.test.ts` |
| worker loop response orchestration | missing | no test runs the worker with fake agent output |
| broker srt explanation | covered | `cargo test --manifest-path broker/Cargo.toml --bin wolfpack-broker` |

## blast radius analysis

| function/symbol | refs found | risk | priority |
|-----------------|-----------:|------|----------|
| `buildSrtSettings` | 22 | high | p1 |
| `buildAgentArgs` | 10 | high | p1 |
| `classifyRalphResponseResult` | 8 | medium | p2 |
| `countRalphProgressFromContent` | 7 | medium | p2 |
| `ensureRalphTransientGitExcludes` | 7 | medium | p2 |
| `runIteration` | 6 | high | p1 |

## historical context

- removed `parseSubtasks()` was introduced in `5ddc682` (`feat: ralph loop — automated iterative task execution (#26)`). Replacing this is a net improvement: it removes a fragile string-as-protocol parser over agent stdout.
- prior srt sandbox support came from `2d6a9ca` (`feat: add srt sandbox wrapping for ralph agent workers (#63)`). This branch widens sandbox write scope for git metadata and codex state; docs explicitly record the accepted risk.
- `buildSrtSettings` had prior audit-related changes in `b10399e`; no security hardening was removed in this diff.

## adversarial analysis

**attacker/misuse models considered:**
- buggy or malicious agent process producing misleading stdout or response files.
- authenticated user starting ralph with chosen agent/worktree/sandbox settings.
- sandboxed agent trying to escape active worktree via git metadata or broker/socket access.

**results:**
- structured response file removes the previous stdout control-channel weakness (`<subtasks>` tag injection in transcript text).
- default srt policy still denies local binding and host broker socket access; broker error text is diagnostic only.
- git metadata write access and full `~/.codex` write access are widened, but documented as intentional and covered by tests. This is risk acceptance, not a hidden regression.
- no auth bypass, shell metacharacter injection, or broker socket exposure found in changed lines.

## verification performed

```text
bun test tests/unit/ralph-response.test.ts tests/unit/ralph-agent-command.test.ts tests/unit/ralph-git-exclude.test.ts tests/unit/ralph-sandbox.test.ts tests/unit/plan-parsing.test.ts
# 113 pass, 0 fail

bun run typecheck
# passed

cargo test --manifest-path broker/Cargo.toml --bin wolfpack-broker
# 3 passed, 0 failed

git diff --check main...HEAD
# no whitespace errors
```

## limitations

- did not run full `bun test` or Playwright e2e.
- did not execute real codex/claude/gemini/cursor against live APIs.
- did not execute ralph worker end-to-end with srt enabled; finding above recommends that missing regression.
- edc context is from 2026-05-18 on `main`; branch has newer ralph-specific changes.

## final recommendation

**conditional approve.** The design fixes a real fragility by replacing stdout tag parsing with structured JSON. The main gap is test depth: this needs one worker-level fake-agent regression before merge, because unit tests alone do not protect the high-risk orchestration path.
