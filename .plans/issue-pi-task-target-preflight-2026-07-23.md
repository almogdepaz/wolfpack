# issue: expose wolfpack target liveness for pi-task dispatch preflight

status: complete; parent-verified and independently reviewed
created: 2026-07-23

## implementation notes

assumptions:

1. extend `wolfpack session status <selector> --json` additively rather than adding `session preflight`; current status route is already the stable identity surface.
2. broker/listed session plus backend liveness is authoritative; terminal snapshots/output remain unrelated and must not be called for status liveness.
3. closed liveness enum for this phase is `ready | dead | unavailable`; Wolfpack cannot infer busy or stale, so it does not publish either state.
4. exact Pi model/task semantics stay out of Wolfpack.

red evidence:

- `bun test tests/unit/session-control-fast-path.test.ts tests/integration/api.test.ts tests/unit/control-api-schema.test.ts` failed as expected for new contract tests: missing `selector/project/projectDir/terminal`, dead liveness returned 200 instead of structured failure, schema rejected new fields. Same run also hit existing unrelated `POST /api/ralph/start validation ordering` git commit timeout from local 1Password signing (`fatal: failed to write commit object`).

progress:

- [x] read repo instructions, plan, session-control docs, schema docs, relevant CLI/server/backend/session-selector modules, and git history for session control.
- [x] added contract/regression tests before production code.
- [x] implemented additive `session status --json` contract: `selector`, `project`, `projectDir`, and `terminal` liveness with closed enum; `projectPath`, `harness`, `session`, and `sessionId` remain preserved.
- [x] dead listed sessions fail closed with HTTP 410 / CLI exit 3 and a structured `SESSION_DEAD` envelope; unknown/ambiguous/backend/auth failures keep bounded structured envelopes.
- [x] generated `docs/generated/control-api.schema.json` and updated schema snapshot/docs.

worker green evidence:

- focused status/schema tests: `bun test tests/unit/session-control-fast-path.test.ts tests/integration/api.test.ts tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts --test-name-pattern 'status|session control API|control api schema'` — 25 pass, 0 fail.
- schema contract: `bun test tests/integration/control-api-schema-contract.test.ts` — 1 pass, 0 fail.
- typecheck after `bun install --frozen-lockfile`: `bun run typecheck` — pass.
- full suite: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` — 1821 pass, 21 skip, 0 fail. gpg signing was disabled only for the test process to avoid the local 1Password git signing failure observed in the red run.
- diff check: `git diff --check` — pass.

## parent takeover and review remediation — 2026-07-24

The implementation worker session closed without publishing `agent_task_done`; the parent cancelled the stale task and continued from its uncommitted worktree.

### contract hardening before review

- red: a new schema test proved `selector`, `project`, `projectDir`, and `terminal` were documented but not required; a CLI test proved a nominal structured failure could reflect a 10,000-character server message.
- change: added `src/session-status-contract.ts` as the closed-set owner, made all machine preflight fields required, normalized known status failures to fixed messages, bounded copied identities, and removed raw response prose from generic CLI failures.
- green: focused schema/CLI tests passed; typecheck and diff checks passed.

### independent review finding 1 — real broker dead state was unreachable

- review reproduction: `BrokerBackend.list()` filters `alive:false` entries before active selector resolution, so the original HTTP 410 test exercised a mock-only state.
- red: `BrokerBackend.inspectSession` regression failed because no broker-authoritative inspection primitive existed.
- change: added optional backend inspection and a `BrokerBackend.inspectSession()` path that resolves name/stable-id ambiguity against the complete `list_sessions` table before active-list filtering. `alive:false` now reaches `SESSION_DEAD`; a reaped target honestly becomes `SESSION_NOT_FOUND`.
- green: the real broker-adapter unit regression and focused route tests pass.

### independent review finding 2 — direct HTTP failures were inconsistent

- review evidence: status returned legacy `{ error, code }` or prose-only envelopes for missing, unknown, ambiguous, and backend-unavailable targets.
- change: added one closed `SessionStatusFailure` envelope for 400/404/409/410/503, fixed messages, explicit unavailable liveness, generated schema coverage, and CLI sanitization for every known status failure.
- green: focused API/schema/CLI suite passed with 30 tests, then the expanded touched-area suite passed with 23 status/schema tests after final schema-message bounding.

### final independent re-review

- verdict: ship; no actionable findings.
- production reproduction: dead broker entry => HTTP 410 `SESSION_DEAD`; reaped target => 404 `SESSION_NOT_FOUND`; name/id collision => 409 `AMBIGUOUS_SELECTOR`.
- CLI reproduction: arbitrary/oversized server prose is replaced by bounded closed messages.
- confirmed status uses broker `list_sessions` inspection and never calls pane/snapshot output.

### final parent verification

- built the real Rust broker: `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker`.
- deterministic schema regeneration: schema SHA-256 `877c879c0aa4b55538eaaed458907061bb161efdbbc698052de91434b9a58eff`; snapshot SHA-256 `bf77e75e9f1c6412c61783d0fd6d9bc45db8c6e4ac4e367b57f375480ea862d5`.
- `bun run typecheck`: passed.
- full suite with real broker coverage: 1839 pass, 0 fail, 0 skip, 1 snapshot across 121 files.
- `git diff --check`: passed.

## summary

`pi-tasks` needs a stable machine-readable Wolfpack target inspection surface so the Pi task communication layer can reject dead/stale/wrong-project targets before dispatching assignment text.

Wolfpack should provide terminal/session facts only. Pi remains the authority for agent task state, active model requirements, issue metadata, context refs, and completion semantics.

## background

A recent multi-agent workflow wasted dispatches on dead or unsuitable target sessions. The task communication layer can avoid this, but only if the Wolfpack transport can ask Wolfpack for liveness/project/session facts before it calls the existing send/prompt path.

Existing docs already describe:

- `wolfpack list --json`
- `wolfpack session status <session-or-id> --json`
- stable `sessionId`
- active state, project path, harness, parent identity
- no terminal output scraping for automation

This issue asks to make that surface sufficient and explicit for Pi task preflight.

## ownership boundary

Wolfpack owns and should expose:

- selector resolution by name or stable session id
- ambiguity failures
- terminal/broker target existence
- broker/pty liveness or stale/dead state
- project path if known
- harness/agent kind if known
- stable session identity
- bounded diagnostics and exit codes

Wolfpack must not expose or decide:

- active Pi model readiness
- `agent_task_*` protocol semantics
- phase/issue/role metadata
- verification tiers
- task completion status
- whether a target has finished work based on terminal text

## requested behavior

### preferred minimal change

Extend or stabilize:

```bash
wolfpack session status <session-or-id> --json
```

so it is sufficient for automated preflight.

Expected success shape, exact names negotiable:

```json
{
  "ok": true,
  "session": "looper-ai-2-sub-agent",
  "sessionId": "stable-id",
  "selector": "looper-ai-2-sub-agent",
  "project": "looper-ai",
  "projectDir": "/Users/home/Dev/looper-ai",
  "harness": "pi",
  "terminal": {
    "exists": true,
    "alive": true,
    "status": "ready"
  }
}
```

Allowed `terminal.status` values should be a closed enum, for example:

```text
ready | busy | stale | dead | unavailable
```

If Wolfpack cannot distinguish `ready` from `busy`, return `alive: true` and `status: "ready"` or `"unavailable"`; do not guess from terminal prose.

### failure shape

For unknown/dead/ambiguous/backend-unavailable targets:

```json
{
  "ok": false,
  "selector": "target",
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "session not found"
  }
}
```

Diagnostic text must be bounded and must not include terminal output.

### optional explicit command

If overloading `status` is undesirable, add:

```bash
wolfpack session preflight <session-or-id> --json [--project <path-or-name>] [--alive]
```

This command should be a thin machine-oriented wrapper around the same session identity/liveness facts. It should still not know Pi model or task semantics.

## acceptance criteria

- `wolfpack session status/preflight --json <stable-session-id>` succeeds for an alive target and returns stable `sessionId`.
- The same command accepts an unambiguous session name and fails closed on ambiguous name/id selectors.
- Unknown targets return nonzero with a bounded JSON error envelope.
- Stale/dead targets are represented as structured liveness failure, not successful active sessions.
- Project path/name is included when Wolfpack knows it, so Pi can compare required project before dispatch.
- No terminal output is read or matched to determine task completion or readiness.
- The command does not expose or require Pi model/task metadata.
- Existing `session status --json` consumers remain compatible, or the change is added under the new `session preflight` command.
- Docs in `docs/session-control.md` mention that Pi/agent task layers should use this only as terminal/session liveness evidence.

## non-goals

- no `agent_task_*` implementation in Wolfpack
- no model inspection
- no task board
- no parsing terminal prose for readiness/completion
- no per-session auth beyond Wolfpack's existing global admission/session-control trust model
- no browser grid/layout state reconstruction

## pi-tasks integration plan

Once this exists, the Wolfpack transport in `pi-tasks` can implement optional transport preflight:

```text
agent_task_send
→ pi-tasks validates task metadata/context refs/conflicting issue task
→ wolfpack transport calls session status/preflight --json
→ pi-tasks combines liveness/project result with Pi-owned model/task readiness
→ dispatch only if required checks pass
```

If Wolfpack liveness is unavailable, `pi-tasks` should surface that as `unavailable`, not invent failure, unless the caller explicitly required reachable/alive target.

## likely touched areas

Implementation likely routes through:

- `src/cli/session-control.ts` or adjacent CLI command parsing
- server session-control/status route if JSON fields are missing there
- broker-backed session adapter/client if liveness state is not currently surfaced
- `docs/session-control.md`
- control API schema/docs/tests if response shape changes

Respect existing invariants:

- broker owns PTY/session liveness
- server/CLI are clients of broker/session state, not hidden PTY owners
- selectors must fail closed on ambiguity
- automation should retain/use stable `sessionId`
