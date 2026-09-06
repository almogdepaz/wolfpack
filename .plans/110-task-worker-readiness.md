# #301 — opt-in task-worker launch readiness

## authorization and scope

user authorized an isolated worktree, plan, terra implementation, independent review/correction loop until the plan and review pass, then a pull request. no merge. issue: https://github.com/almogdepaz/wolfpack/issues/301

base: main `3276836bde5663927452735276736f8135a98c36`
worktree: `/private/tmp/wolfpack-issue301`
branch: `feat/task-worker-readiness`
status and role assignments: `.plans/110-task-worker-readiness.status.md`

## assumptions and trust model

- tailnet admission is for honest authorized users. preserve ordinary global auth; do not invent inter-session authorization, malicious-local-user defenses, signing, sandboxing, or hostile-peer protocols.
- protect against mistakes: wrong checkout, missing/dangling executable or required integration paths, dead launch, expired/mismatched endpoint, and accidental teardown of a different session.
- readiness means the exact live pi session has a currently registered v2 task endpoint and the intended launch root. it does not prove model/provider availability, task execution, semantic state, or filesystem isolation.
- no worktree creation/deletion policy, no task scheduler, no v1 fallback, no terminal-output readiness parsing, no pi-tasks package modifications.
- favor a small opt-in extension of existing session launch contracts and gateway lookup, not a parallel launch authority.

## existing authorities to reuse

read `edc-context/index.md`, manifest and routed module docs; generated context is advisory and source wins. relevant production sources:
- `src/server/project-settings-routes.ts`, `project-selection.ts`, `validate-project-dir.ts`: strict body/project selection and canonical directory validation.
- `src/server/session-open.ts`, `session-create.ts`: allocation and parent identity semantics.
- `src/server/broker-backend.ts`, `backend.ts`, `session-identity.ts`: argv-safe launching, stable broker identity, exact lifecycle.
- `src/task-relay/gateway.ts:endpointForSession` and store registrations: session-bound, lease-aware opaque v2 endpoint authority.
- `src/cli/session-control.ts`, `session-open-contract.ts`, `session-create-contract.ts`, `control-api/schema.ts`: CLI/API compatibility and generated docs.
- canonical operator docs: `docs/session-control.md`, `docs/control-api-schema.md`, `docs/agent-skills.md`; extend, do not duplicate.

## delivery steps

### 1. finalize the minimal opt-in contract and write regression tests

- inspect git log/blame for affected launch code before proposing replacements.
- implement task-worker mode for `agent spawn` and top-level `session create` through their existing server-owned endpoints; keep the deprecated child alias consistent.
- require explicit intended canonical project/worktree root in task-worker mode (`--project-dir` can carry that intent); reject ambiguous/named-only selection and reject a returned/resolved launch root that differs. do not treat a label as identity.
- add one explicit mode flag and bounded readiness deadline, with typed result/error codes and opaque `taskEndpoint` success. decide exact fields against existing validation/types; record final shape in status before production edits.
- inspect installed pi docs completely for the actual executable/config/extension mechanisms used, following related markdown links before using those APIs. do not reconstruct the whole pi package resolver. prefer explicit opt-in configured executable and required extension paths with deterministic documented defaults if existing configuration offers no authoritative resolver. validate the paths actually used for launch, not unrelated guessed paths. ordinary working package-manager executable symlinks must remain usable; broken links, non-files, non-executable binaries, unreadable required extensions, malformed paths must fail clearly. no guessed package compatibility claims.
- task-worker launch must not run initial assignment prompts before readiness; reject incompatible prompt/plan/notify-parent combinations if necessary rather than silently executing work before the gate. decide whether the existing `PI_TASK_WORKER=1` leaf gate is appropriate from documented installed package behavior; do not conflate leaf-only policy with endpoint readiness.
- use the narrowest behavior tests first and observe expected red before production implementation. real temp files/worktrees and real relay registration/store are preferred; fake only the process/broker boundary when unavoidable.

### 2. implement preflight, launch, readiness, exact failure cleanup

- resolve/validate launch resources before creating the worker; pass paths and optional model through argv boundaries, never string-interpolate user paths into shell code.
- preserve normal interactive launch behavior when opt-in mode is absent.
- pin the created stable session id and expected canonical project root. verify live structured session facts and lease-valid `endpointForSession(id)`; readiness waits are bounded and do not read terminal content.
- use constants for timeout/poll limits. align CLI HTTP timeout with the server readiness window; avoid unbounded polling and redundant generic retry machinery.
- on post-create failure/timeout, clean up the exact created id only. handle name reuse, parent change, dead sessions, backend unavailability and cleanup failure without claiming successful cleanup when unavailable. never remove worktrees, branches, or unrelated sessions. reuse existing exact-id kill behavior where available.
- do not notify/report successful ready-worker creation before the readiness gate. failure envelopes must retain useful created-session identity/cleanup disposition when cleanup cannot be confirmed.

### 3. complete public contract and focused verification

- update source-owned schema, regenerate canonical schema/docs with existing generator, update CLI help and canonical session-control examples and bundled control skill only where needed.
- regression coverage: successful readiness and unchanged ordinary launch; wrong intended/returned worktree; dangling executable and extension; valid executable symlink; missing/expired/foreign endpoint; early exit; deadline; post-create failure; exact-id cleanup under name reuse; cleanup failure; invalid/oversized request/timeout/path and incompatible harness/prompt options; model argv preservation; CLI/API parity.
- verify installed-client happy path with an isolated disposable launch if practical; no production service restart or change to the user's pi configuration. if impossible, surface exact unverified boundary rather than fabricating a smoke pass.
- run focused tests and typecheck/schema checks; retain red/green commands, exit status, and logs under `.plans/` evidence paths. no full suite inside iterative loops.

### 4. independent review and sequential corrections

- persistent separate read-only reviewer reads the final diff including new files against recorded base, this plan, issue acceptance criteria, tests and fresh evidence.
- review through delivery/architecture, correctness/trust boundaries, quality/test value, and antipattern lenses using installed skills. honest-tailnet threat model is explicit: no findings demanding adversarial authorization or local-user sandboxing. existing auth and accidental data-loss protections must remain.
- reviewer does not edit production/tests/git state. review reports may be returned as task results for parent to persist; keep role read-only.
- parent validates/deduplicates actionable findings. implementer fixes verified issues sequentially with regression evidence; reuse both sessions for corrections/re-review until no actionable in-scope findings remain.
- stop only for genuine product ambiguity, unsafe/untestable risk needing user choice, or infrastructure blocker. do not silently reduce issue acceptance criteria.

### 5. integration gate and pr

- parent checks final source/diff against each acceptance criterion, diff hygiene, focused evidence and reviewer result.
- run full repository test suite once at final stable integration gate, plus required typecheck/build/schema checks. isolate failures and compare same tests against base before classifying; fix only introduced regressions.
- stage only #301 files, explicitly force-add this plan/status if ignored. no unrelated changes, version bump, generated frontend bundle churn, or AGENTS edits.
- user explicitly requested a pr: parent may commit scoped verified changes, push this branch and open a pr referencing `closes #301`, with truthful verification and remaining limits. no merge.
- acknowledge terminal assignments once. retain workers during review loop; close parent-owned role sessions with stable-id `wolfpack kill` and verify absence from `wolfpack list --json` when phase ends. retain worktree for the pr.

## completion checklist

- [x] contract recorded; tests prove preflight/readiness failures before implementation
- [x] intended canonical root binding and actual launch resource validation
- [x] stable-session, live v2 endpoint readiness and bounded timeout
- [x] exact-created-session cleanup and truthful failure disposition
- [x] ordinary launches unchanged; no new adversarial trust model
- [x] CLI/API/schema/docs agree
- [x] focused verification and independent review pass
- [x] final integration result classified against baseline
- [ ] scoped commit pushed and pr opened
- [x] terminal tasks acknowledged and role sessions cleaned up

final evidence and limitations: `110-task-worker-verification.md`; final independent reviews: `review-301-pass3.md`, `review-301-final-gate.md`.
