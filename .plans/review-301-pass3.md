# #301 final re-review — pass 3

## Verdict

**APPROVE — no remaining actionable findings.**

| Lens | Verdict |
|---|---|
| Security | APPROVE |
| Delivery | APPROVE |
| Architecture | APPROVE |
| Quality / test value | APPROVE |
| Antipatterns | APPROVE |

Scope: corrected full tracked diff and untracked `src/server/task-worker-readiness.ts`, `tests/unit/task-worker-readiness.test.ts`, `tests/e2e/task-worker-readiness.e2e.ts`, and `tests/e2e/task-worker-early-exit.e2e.ts` against `3276836bde5663927452735276736f8135a98c36`. Threat model remains honest authenticated Tailnet users.

## Prior finding dispositions

| Finding | Final disposition | Evidence |
|---|---|---|
| TW-001 hard deadline | **fixed** | `boundOperation` accepts a thunk, refuses zero budget, and clock-validates a raced success (`src/server/task-worker-readiness.ts:180-200`); readiness clock-checks again before endpoint return (`:283-299`). The deterministic final-liveness regression crosses the deadline in its completion microtask (`tests/unit/task-worker-readiness.test.ts:134-178`). |
| TW-002 cleanup truth | **fixed** | only exact `NOT_FOUND` or the matching dead UUID confirms cleanup (`src/server/task-worker-readiness.ts:203-229`). |
| TW-003 Pi liveness | **fixed** | task-worker launch directly execs Pi, without a fallback shell (`src/server/broker-backend.ts:414-418`), and readiness performs final structured liveness validation (`src/server/task-worker-readiness.ts:283-299`). Behavioral register-then-exit coverage is at `tests/e2e/task-worker-early-exit.e2e.ts:54-67`. |
| TW-004 CLI recovery JSON | **fixed** | strict recovery parsing/projection remains present and covered by the focused pass-2 suite. |
| TW-005 executable preflight | **fixed** | regular-file plus effective `X_OK` validation remains present; valid and invalid permission/symlink cases pass (`src/server/task-worker-readiness.ts:96-113`; `tests/unit/task-worker-readiness.test.ts:23-72`). |
| TW-006 schema/runtime parity | **fixed** | exclusive request modes and typed worker recovery definitions remain current (`src/control-api/schema.ts:173-251,365-383,1105-1140`); generated-schema and route-schema evidence is green. |
| TW-007 acceptance depth | **fixed** | additions now cross the previously missing preflight, real relay-store, parent-failure, public route/schema, early-exit, and real smoke boundaries. |

## Acceptance and evidence assessment

### Deadline correctness

The former timer-ordering bug is corrected at both semantic boundaries: a raced operation is rejected when the absolute clock has reached/passed the deadline, and a final check prevents a late endpoint return. Starting the operation through a thunk also prevents zero-budget work from being launched.

The authoritative red is `.plans/evidence/110-task-worker-pass2-red-tw001-corrected-regression.log`: restored old semantics resolved when rejection was expected (exit 1). Current production passes the same regression (`110-task-worker-pass2-green-tw001-corrected-regression.log`) and the complete readiness file passes 13/13 (`110-task-worker-pass2-unit-after-corrected-red.log`). The earlier mis-specified attempt is explicitly disclaimed in `.plans/110-task-worker-implementation.md` and was not counted as red evidence.

### Missing acceptance paths

- valid executable plus missing extension: `tests/unit/task-worker-readiness.test.ts:52-63`;
- live exact-root session with no endpoint through a real deadline: `:199-230`;
- expired worker registration plus unrelated live foreign registration through the real gateway store: `:232-294`;
- wrong-root and replacement identity with exact-ID cleanup: `:334-399`;
- parent disappearance/replacement after worker creation with recovery envelope and exact UUID cleanup: `tests/unit/session-open.test.ts:385-412`;
- public create/open successes and post-create recovery bodies validated against generated contracts: `tests/integration/api.test.ts:952-1040`;
- broker-observed Pi registration followed by process exit: `tests/e2e/task-worker-early-exit.e2e.ts:23-67`.

These additions address the composition gap rather than merely adding more seam mocks.

### Real Pi smoke

`tests/e2e/task-worker-readiness.e2e.ts:65-126` now proves the intended narrow boundary:

- installed `pi` plus the explicit installed Pi Tasks extension reaches the disposable server relay;
- the response has Pi identity and an opaque UUID relay endpoint;
- exact-ID status reports the canonical temporary root, Pi harness, and live terminal;
- exact-ID kill succeeds and the ID disappears from the active list before fixture teardown.

Environment/state trace is correct:

- fixture values configure the disposable server (`tests/e2e/task-worker-readiness.e2e.ts:42-58`);
- worker-only production projection forwards server `WOLFPACK_PORT` and `HOME` (`src/server/broker-backend.ts:431-450`);
- broker applies those values to the spawned command (`broker/src/session.rs:250-257`);
- `WOLFPACK_DEV_DIR` remains correctly server-side, isolating the relay store; the child reaches that store over the forwarded port;
- launch uses `--no-extensions --extension <validated absolute path>`, so extension registration does not depend on ambient extension discovery.

The smoke is not a sandbox/hermetic-environment test and does not prove provider/model readiness or task execution, none of which #301 promises. It does not explicitly clear ambient `PI_CODING_AGENT_DIR`; in the reviewed environment that variable is unset, and explicit extension selection plus temporary `HOME` makes the recorded smoke valid. This is not an actionable finding under the approved scope/trust model.

The corrected smoke runs once under the desktop Playwright project and no longer turns application cleanup failure into a passing test. Evidence: `.plans/evidence/110-task-worker-pass2-real-smoke.log`, 1 pass.

### Focused verification

Fresh supplied evidence is internally consistent:

- affected unit/integration set: 324 pass, 0 fail (`110-task-worker-pass2-focused.log`);
- readiness suite after corrected red: 13 pass, 0 fail;
- focused public route/schema scenario: 1 pass;
- real Pi smoke: 1 pass;
- behavioral early-exit E2E: 1 pass;
- schema generation and TypeScript typecheck: exit 0.

Counts overlap and are not treated as aggregate acceptance proof; source and individual behavior were inspected. `git diff --check` is clean. Per assignment, no full suite was run; the parent owns that final gate.

## Four-lens notes

### Security — APPROVE

Ordinary route auth is preserved. User-controlled paths/model remain separated as argv values. Exact stable IDs, canonical roots, effective file access, and truthful cleanup protect against operator mistakes without inventing adversarial inter-session controls. Worker-only `HOME`/port forwarding is server-owned, mode-scoped, and does not widen public input authority.

### Delivery / architecture — APPROVE

The implementation now meets the plan's opt-in contract and uses existing owners: routes validate/map, session create/open orchestrate, `BrokerBackend` owns launch/exact kill, broker inspection owns identity/liveness, and `TaskRelayGateway` owns lease-valid endpoint lookup. No parallel launcher, v1 fallback, terminal prose protocol, scheduler, or worktree lifecycle was introduced.

### Quality / test value — APPROVE

The deadline regression is deterministic and genuinely distinguishes old/current behavior. New tests exercise production schema validation, a real gateway store, disposable broker process behavior, and installed Pi rather than substituting assertion-only mocks. TypeScript remains typed and narrow; no suppressions or swallowed production diagnostics were introduced.

### Antipatterns — APPROVE

The prior race hazard and E2E error hiding are removed. No new magic protocol literals, mixed-concern blob, diagnostic suppression, speculative abstraction, or material duplication warrants action. The small duplicated E2E port allocator is below the repository's extraction threshold.

## Optional / pre-existing

- Future smoke hardening could explicitly fixture-bind `PI_CODING_AGENT_DIR`, but this is not required for the narrow installed-extension readiness claim.
- Existing large route/integration modules predate #301 and do not justify scope expansion.
- Final repository-wide verification remains pending with the parent, as planned.
