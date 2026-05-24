# ralph json response status

Goal: replace stdout `<subtasks>` control parsing with a dedicated json response file written by the agent and read by ralph.

## status

- [x] switch to pr branch `fix/ralph-codex-srt`
- [x] inspect current ralph prompt/subtask flow
- [x] add failing regression tests for json response parsing/prompting
- [x] implement minimal json response reader + prompt wiring
- [x] inspect stopped ralph log
- [x] identify missing-response false-completion bug
- [x] verify focused tests after missing-response fix
- [x] run broader typecheck/tests if feasible

## 2026-05-22 debug notes

- `.ralph.log` shows the run was on `TERMINAL_LOAD_OPTIMIZATION_PLAN.md`, not the review-finding task.
- Codex repeatedly logged `failed to refresh available models` from `https://chatgpt.com/backend-api/codex/models`; no srt permission-denied error appeared in the retained log.
- User sent SIGTERM at `03:06:10`; shutdown cleanup ran and removed one worktree.
- After SIGTERM, the main loop still resumed, logged `Missing ralph response file`, marked iteration 1 complete, and wrote a summary. root cause: missing/invalid `.ralph-response.json` was only warned, not treated as non-completion, and the loop did not bail after `stopping` became true.
- Added `classifyRalphResponseResult()` tests: missing/invalid response files classify as `not_completed`; only explicit `done` marks completion; `needs_subtasks` expands subtasks.
- Focused verification passed: `bun test tests/unit/ralph-response.test.ts tests/unit/ralph-prompt.test.ts tests/unit/ralph-sandbox.test.ts tests/unit/plan-parsing.test.ts` (103 pass).
- Broader verification passed: `bun run typecheck`; `bun test` (1487 pass).
- Full code-path trace found another cross-agent issue: the prompt showed invalid JSON (`"status": "done" | "needs_subtasks"`). Added a failing prompt test and replaced it with two valid JSON examples for every supported agent.
- Fake-agent end-to-end smoke through `src/cli/index.ts worker` passed for `claude`, `codex`, `gemini`, and `cursor`: each fake binary extracted the response path from the real prompt, wrote `.ralph-response.json`, and ralph marked the checkbox done.
- Smoke also exposed misleading summary progress (`plan progress: 0/1 done`) because `logSummary()` counted plan markers, not `progress.txt`. Added `countRalphProgressFromContent()` regression tests and changed the summary to use progress DONE keys. Re-run smoke now shows `plan progress: 1/1 done` for all four agents.
- Second real Codex run still thrashed: repeated model-refresh noise plus apply_patch failures, no `.ralph-response.json` after several minutes. Root cause is Codex orchestration, not the JSON parser: ralph was asking Codex to manually write the response file instead of using Codex's native structured-output path.
- Added `src/ralph-agent-command.ts`: Codex now runs with `codex exec --dangerously-bypass-approvals-and-sandbox --output-last-message <response-file> --output-schema <schema-file> <prompt>`. Removed legacy `--yolo` for Codex. Other agents keep existing invocations.
- Added `tests/unit/ralph-agent-command.test.ts`; fake-agent smoke verifies the schema file exists and all four agents complete. Verification passed: `bun run typecheck`; `bun test` (1493 pass).
- Real loop after deploy failed with proof in `.ralph.log`: Codex contacted the backend and got `400 invalid_json_schema` because `version`/`status` schema properties omitted `type`. This was not the primary sandbox failure: log showed ralph `sandbox: srt`, Codex internal `sandbox: danger-full-access`, then an OpenAI schema validation response. Fixed schema by adding `type: "number"` to `version` and `type: "string"` to `status`; regression test now covers both. Verification passed: `bun run typecheck`; `bun test` (1494 pass).
- Debugged Codex refresh/app warnings with direct vs srt diagnostic runs. `wham/apps` reproduced only under srt and disappeared with `codex exec --disable apps`; Codex still completed and wrote the same `.ralph-response.json` contract. Added `--disable apps` to Codex invocation and a regression test that all agents receive the `.ralph-response.json` contract.
- Real installed Codex+srt smoke after `--disable apps` completed successfully and had `wham=0`, `schema=0`, but still logged `failed to refresh available models` 7 times. The model-refresh warning is therefore not fixed by disabling apps and remains a Codex/backend/cache issue; it did not block completion in that smoke.
- The same real smoke exposed Codex committing `.ralph-response.json`, then the runner deleting it as a transient file and leaving a `D .ralph-response.json` worktree status. Updated the prompt and regression tests to tell all agents not to commit runner-owned files: `.ralph-response.json`, progress/log/temp/schema/srt settings. Added `ensureRalphTransientGitExcludes()` so the active worktree's `.git/info/exclude` ignores runner-owned files and `git add -A` does not stage them.
- Real Codex+srt smoke then failed at `git commit` because srt allowed the worktree but not linked-worktree git metadata. Added git metadata write allowances for normal repos and linked worktrees, documented the sandbox scope, and covered both cases in `ralph-sandbox.test.ts`.

## why the initial review missed these follow-on bugs

- The differential review explicitly scoped itself to committed `main...HEAD`. The JSON response files were dirty/untracked after the review, so the missing-response and invalid-json-shape bugs were not in the reviewed diff.
- The review did catch the underlying design hole as M1: no trusted completion/subtask channel, and recommended a JSON response file plus loop-decision regression coverage.
- The review did not execute a loop smoke. Static review found the contract gap, but the bad implementation details only surfaced once the new contract existed and a stopped/fake loop exercised it.
- The misleading `plan progress: 0/1 done` summary was pre-existing/non-differential behavior from `logSummary()` counting plan markers instead of `progress.txt`; it was outside the codex+srt PR diff and not security-significant enough for that review mode.

## assumptions

1. every agent uses `.ralph-response.json` as the runner control channel.
2. json schema should be tiny: response kind plus subtasks/tests/done/prereqs fields.
3. stdout is never a runner control channel; missing/invalid response file means not complete.
