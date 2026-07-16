# simplify agent-native session open for the tailnet trust model

**status:** implemented and verified locally — review findings 2, 3, 5, and corrected 6 fixed; not deployed, restarted, committed, pushed, or merged
**branch:** `feat/session-open` at `3304f5165decd254c1d88c3cddda41f1b741776b`
**worktree:** `/private/tmp/wolfpack-dev07`
**goal:** make sub-session creation a single server-owned operation without introducing inter-session credentials; the tailnet/global Wolfpack auth setting remains the trust boundary.

## accepted contract

- command: `wolfpack session open <project> [--prompt <instruction>] [--json]`.
- parent context comes only from `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND`; no process ancestry or terminal parsing.
- one explicit launch prompt may be passed as opaque harness argv; no parent transcript/model state is passed by Wolfpack.
- child names are server-generated: `<parent>-sub-agent`, then `<parent>-sub-agent-2`, etc.; preserve the suffix by truncating only the parent prefix at 100 characters.
- server derives the child harness from the active parent’s structured identity. No client command/harness override.
- project must be an exact existing configured project. No prefix matching and no project creation.
- structured parent UUID/name is persisted and exposed; browser grouping remains identity-based.
- browser notification remains best-effort after successful creation.
- tailnet/global Wolfpack auth is the trust boundary. Sessions may list and communicate with other sessions.
- do not add scoped JWTs, opaque bearer capabilities, token indexes, or agent-side service-auth fallback.
- when global JWT is enabled, this endpoint follows the ordinary JWT middleware like every protected API endpoint; no special legacy-session bypass.

## current worktree warning

The previous worker left an uncommitted 16-file auth experiment. Before implementation:

1. confirm `HEAD` and `origin/feat/session-open` are both `3304f5165decd254c1d88c3cddda41f1b741776b`;
2. confirm the dirty tracked files are exactly the following, plus this new plan file:
   - `.plans/005-agent-native-session-open.md`
   - `docs/session-control.md`
   - `src/auth.ts`
   - `src/cli/api.ts`
   - `src/cli/service-auth.ts`
   - `src/cli/session-control.ts`
   - `src/server/backend.ts`
   - `src/server/broker-backend.ts`
   - `src/server/http.ts`
   - `src/server/index.ts`
   - `src/server/mock-backend.ts`
   - `src/server/routes.ts`
   - `tests/integration/auth-middleware.test.ts`
   - `tests/unit/broker-backend.test.ts`
   - `tests/unit/broker-ws-attach.test.ts`
   - `tests/unit/session-control.test.ts`;
3. if anything else is dirty, stop and report it;
4. restore only those 16 tracked files to `HEAD`. Do not use `git reset --hard`, do not remove this plan, and do not touch unrelated worktrees.

The clean baseline already contains the parent hierarchy, initial-prompt argv, browser grouping, grid notification, schema, docs, and tests from commit `3304f51`.

## 1. restore the baseline and lock regressions first

- Restore the exact auth-experiment files listed above and confirm the remaining diff is only this plan.
- Add failing tests before production changes for:
  - CLI open performs exactly one `POST /api/session-open` and never calls `GET /api/sessions` or general `/api/create`;
  - server derives the first and numbered child names from the parent, including 100-character suffix preservation;
  - concurrent/stale-name collisions retry only on typed `DuplicateSessionError` and stop at a bounded limit;
  - endpoint rejects missing/invalid parent context, unsupported `shell`/`unknown` harness identity, unknown request fields, non-existing projects, command/name/new-project overrides, blank prompts, and oversized prompts;
  - successful creation preserves the exact parent UUID/name, launches the same harness, forwards the prompt unchanged, and emits notification only after success;
  - parent disappearance or UUID replacement during allocation fails closed before another create attempt.
- Preserve existing tests proving prompt argv is opaque and no shell interpolation occurs.

## 2. add one server-owned session-open operation

- Add `POST /api/session-open` with strict request shape:

```ts
{
  project: string;
  parentSession: string;
  initialPrompt?: string;
}
```

- Reject unknown fields. This route never accepts `newProject`, `cmd`, or `sessionName`.
- Resolve the active parent through broker-backed session truth and structured identity; require the requested parent name to match that active identity.
- Derive the harness from `identity.agentKind` and accept only `pi`, `claude`, `codex`, `gemini`, or `cursor`.
- Require an exact existing project and reuse existing project path-containment/symlink validation.
- Move parent-scoped naming into a small production module such as `src/server/session-open.ts`; the CLI must not own naming.
- Allocate names server-side with bounded retries. On each retry, confirm the parent UUID is unchanged, then retry only a typed broker duplicate.
- Call the existing backend with derived harness, structured parent identity, and optional prompt. Do not add auth/token fields to `SessionLaunchOptions`.
- Return the existing deterministic success envelope:

```json
{"ok":true,"session":"parent-sub-agent","project":"wolfpack","harness":"pi"}
```

- Preserve stable machine-readable failures for invalid request, parent missing/changed, identity unavailable, unsupported harness, project missing, collision exhaustion, and backend unavailable. Keep the set minimal and schema-backed.
- Emit `sub_session_opened` only after creation succeeds. Include stable parent identity in the event if required to prevent same-name replacement from receiving stale intent; browser still owns grid state.

## 3. simplify the CLI and update contracts

- `wolfpack session open` sends one request to `/api/session-open`; remove client-side session listing, naming, and collision retries.
- Keep structured local context validation so missing parent and `shell`/`unknown` harness fail before network access.
- Keep `DuplicateSessionError` translation in `BrokerBackend`; general `/api/create` and the new endpoint must receive typed duplicate behavior.
- Keep JWT warnings on stderr so `--json` stdout remains exactly one envelope.
- Treat `--prompt --json` as a missing prompt value. If literal known-option text is supported, add an explicit unambiguous `--prompt=<instruction>` form and regression coverage; continue accepting ordinary flag-shaped text that is not a known option.
- Do not read `~/.wolfpack/service-auth.json` from shared CLI request code.
- Update `src/control-api/schema.ts`, generated schema/snapshot, README/session-control/session-identity docs, skill docs, and this plan. State plainly that nested open uses ordinary global API auth policy and adds no inter-session authorization layer.

## 4. verify without publishing or restarting the broker

- Focused tests: CLI parsing/behavior, API route, broker backend, schema contract, identity, docs/skill, and browser notification/grouping tests.
- Full Bun suite: `bun test --max-concurrency 8` with commit signing disabled for fixtures.
- Rust suite serially: `cargo test -- --test-threads=1`.
- Full applicable Playwright suite.
- Typecheck root and browser projects.
- Regenerate schema, browser bundles, and embedded assets twice; prove deterministic hashes and clean generated diffs.
- Run production build and `git diff --check`.
- Do not deploy, restart server/broker, commit, push, or merge. Report results and wait.

## execution record

- restored exactly the listed 16-file auth experiment; baseline then contained only this plan.
- regression-first coverage added for one-request CLI behavior, strict route validation, server-owned naming/allocation, typed duplicate retries, parent replacement/disappearance, ordinary JWT middleware, schema/docs, and post-success notification.
- `bun test --max-concurrency 8`: 1739 passed.
- `cargo test --manifest-path broker/Cargo.toml -- --test-threads=1`: 174 tests passed plus doc tests.
- `bunx playwright test`: 86 passed, 109 platform-applicability skips.
- root and browser TypeScript typechecks passed.
- schema, browser bundles, and embedded assets regenerated twice with identical SHA-256 hashes; only the intentional control API schema artifact changed among tracked generated files.
- production build, `git diff --check`, trust-boundary grep, and final focused suite passed.
- after plan 007 landed, combined verification passed: 1749 Bun tests, 174 Rust tests, 86 Playwright tests with 109 platform-applicability skips, typechecks, deterministic generation, and four-target build.
- review finding 2: one shared production contract now owns the openable harness catalog/guard and complete endpoint error-code union; regression observed red on the missing contract, then 180 focused tests, typecheck, schema generation, and diff-check passed.
- review finding 3: the shared contract now owns endpoint error HTTP statuses; allocation errors, session-open routes, schema generation, and runtime regressions consume it without regex parsing of schema prose. Regression observed red, then 180 focused tests with 499 assertions and typecheck passed.
- review finding 3 follow-up: private `sessionOpenErrorLines` is the sole formatter; the contract regression asserts the concrete `controlApiSource` output. The same 180 focused tests, typecheck, and deterministic generation passed.
- review finding 5: removed the test-only formatter export and redundant helper assertion; 11 focused contract/schema tests, typecheck, deterministic generation, and diff-check passed.
- review finding 6, corrected: route-specific parse-helper responses preserve coded `INVALID_REQUEST` envelopes for malformed in-limit and non-object session-open bodies. Oversized bodies retain immediate socket destruction and the existing reset-or-generic-400 transport contract with no machine-code guarantee. The correction regression observed an oversized chunked connection remaining open, then 182 focused HTTP/API/session/schema/auth tests and typecheck passed.

## success criteria

- one CLI request creates the correct child without terminal typing or readiness sleeps;
- naming, same-harness selection, parent identity, exact-project validation, collision retries, and notification are server-owned;
- no new bearer/session credential machinery exists;
- no shared CLI path reads the service-auth signing secret;
- existing parent hierarchy/grid behavior and all pre-existing PTY/session invariants remain covered;
- full verification is green;
- final worktree contains only intentional implementation/docs/generated changes plus this plan.
