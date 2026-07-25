# issue #210 phase 1 — atomic prompt and output wait

status: phase 1 complete — all review findings resolved, independently re-reviewed, and parent-verified; no commit created.

assumptions:
1. the cli command is `wolfpack session prompt <session-or-id> <prompt...> --until <text>` with optional `--no-enter`, `--timeout-ms`, and `--json`.
2. phase-1 output is limited to the explicit `output_contains` predicate. typed agent-state and delegated-task predicates remain deferred to #209/#211.
3. the broker's atomic live subscription plus stable UUID input plane is the observation boundary; existing subscribers may share that broker subscription because the operation registers its own callback before input is sent.
4. phase-1 reports only outcomes observable from current broker primitives: `matched`, `timed_out`, `target_exited`, `target_unavailable`, `replay_gap`, and `backend_unavailable`. an explicit cancellation response is deferred because a disconnected HTTP client cannot receive it and the broker has no operation-cancellation primitive.

## independent review findings

- high, finding 1 resolved: subscribe `current_seq` no longer overwrites the delivered-output reconnect cursor.
- high, finding 2 resolved: output frame sequences are preserved and replay at or before `outputBoundarySeq` is excluded from matching.
- medium, finding 3 resolved locally: reconnect resubscribe failures now unwind shared subscribers and terminate prompt waits with typed outcomes.

review task: `task_b80907a454f4464fbce9454a9e1cbb4a`; deterministic reproductions confirmed all three findings.

### finding 1 evidence

- root cause: `issueSubscribe` copied response `current_seq` into `activeSubscriptionSeq`, but the broker queues that response before replay. reconnect and subscription-drop recovery then treated undelivered replay as delivered.
- red: `bun test tests/unit/broker-client.test.ts --test-name-pattern 'reconnect resumes after the last delivered frame'` expected reconnect `since_seq=42` from the last delivered output frame but observed subscribe watermark `99`.
- fix: keep `activeSubscriptionSeq` as the caller-provided replay floor/last delivered `OUTPUT_BINARY` cursor; retain #210's subscribe watermark separately in the subscribe response consumed by `BrokerBackend`.
- green: the narrow regression passed 1/1; `bun test tests/unit/broker-client.test.ts tests/unit/broker-backend.test.ts` passed 110/110; `bun test tests/integration/broker-backend.test.ts` passed 7/7 against the real broker; `bun run typecheck` completed without diagnostics.
- finding 2 (replay at/before the prompt boundary) and finding 3 (resubscribe failure propagation) were intentionally untouched by the finding 1 task.

### finding 2 evidence

- root cause: `BrokerBackend` discarded each `OUTPUT_BINARY` frame sequence and matched all buffered text after input, including pending shared-subscription replay at or before the reported subscribe watermark.
- red: `bun test tests/unit/broker-backend.test.ts --test-name-pattern 'pending shared replay at the subscribe watermark'` expected `timed_out` at boundary `17`, but old seq-17 `READY` replay produced `matched`.
- fix: preserve `OutputBinaryFrame.seq` through shared registration, use the maximum of registration replay progress and subscribe watermark as the effective boundary, retain a bounded pre-readiness frame queue, and decode/match only frames newer than that boundary.
- green: the narrow finding-2/compatibility set passed 4/4, including immediate output, split UTF-8 output, pending replay exclusion, and shared registration timing; `bun test tests/unit/broker-client.test.ts tests/unit/broker-backend.test.ts` passed 112/112; `bun test tests/integration/broker-backend.test.ts` passed 7/7 against the real broker; `bun run typecheck` completed without diagnostics.
- finding 3 (resubscribe failure propagation) was intentionally untouched by the finding 2 task.

### finding 3 evidence

- root cause: `BrokerClient` cleared its reconnect subscription state and invoked optional `onResubscribeError`, but `BackendRouter` did not wire that callback to `BrokerBackend`'s shared subscriber error/cleanup path.
- red: `bun test tests/unit/broker-backend.test.ts --test-name-pattern 'maps reconnect unknown_session failure instead of timing out'` expected `target_unavailable` at boundary `17`, but the unwired failure returned `timed_out`.
- fix: wire `BrokerClient.onResubscribeError` in `BackendRouter`, route it to `BrokerBackend`, and reuse one idempotent shared-subscriber unwind path for initial and reconnect subscribe failures.
- green: reconnect `unknown_session` and `session_not_alive` prompt outcomes plus duplicate-callback/ref cleanup passed 3/3; `bun test tests/unit/broker-client.test.ts tests/unit/broker-backend.test.ts tests/unit/backend-router.test.ts` passed 131/131; real-broker integration passed 7/7; API prompt tests passed 2/2; `bun run typecheck` completed without diagnostics.
- independent re-review `task_ea0bb178c4584749b3c08f006bf9fd2f` confirmed all three original fixes and found one request-body contract defect.

### request-body contract re-review evidence

- root cause: the prompt schema publishes prompt/output maxima whose valid JSON encodings exceed the shared 64 KiB body limit; `readBody` destroys the request on overflow, so callers receive a socket reset instead of route validation or JSON.
- red: the real API body-parser tests for schema-max prompt/output strings and a body beyond the intended route cap both failed with `ECONNRESET` before route handling.
- fix: add a prompt-only request cap derived from the declared selector/prompt/output maxima and worst compact JSON escaping, count Unicode code points consistently with JSON Schema, and let that route return a stable JSON 413 without raising or weakening the default 64 KiB limit. the prompt selector now has a route-specific published maximum; prompt/output maxima are unchanged.
- compatibility correction: the first body-reader change preserved connections globally; the existing session-open oversized-chunk test caught that regression, so connection preservation was narrowed to prompt while default routes retain transport termination.
- green: schema-max escaped/UTF-8 request and route-cap JSON 413 passed through the real parser; full API passed 126/126 with 340 expectations; auth passed 30/30; schema unit/runtime-contract passed 12/12 with 61 expectations; typecheck passed; schema regeneration was byte-stable at SHA-256 `81d501534c8e7e3fd7108ff86468848f3b6063ba042c1589fbca92c0db0e3093`; diff and trailing-whitespace checks passed.
- final re-review `task_6d381983c9d34356876dc89809ac4656` confirmed all four prior fixes and found one Unicode-unit mismatch.

### Unicode-unit final-review evidence

- root cause: route/schema maxima use Unicode code points, while CLI prompt validation and broker decoded/pending buffers use UTF-16 units or raw bytes.
- red 1: a 20,000-code-point astral CLI prompt was rejected as usage because its UTF-16 `.length` is 40,000.
- red 2: an exact 32,769-code-point astral output needle emitted after input returned `timed_out` because decoded rolling truncation cut it at 65,536 UTF-16 units.
- red 3: an exact 40,000-code-point `é` needle emitted post-boundary before readiness returned `timed_out` because the pending queue retained only 65,536 of its 80,000 UTF-8 bytes.
- fix: centralize allocation-free Unicode code-point length/suffix helpers in the prompt contract; use them in route, CLI, and broker validation/buffering; retain decoded suffixes by code point without splitting surrogate pairs; cap pending binary output at `4 * 65,536 + 3 = 262,147` bytes and trim exact byte overflow instead of dropping whole frames.
- green: all three red reproductions passed, plus worst-case UTF-8 decoder-alignment and helper contract coverage; focused CLI/broker/schema tests passed 166/166 with 388 expectations; full API passed 126/126 with 340 expectations; real broker passed 7/7; schema-runtime/auth passed 31/31 with 98 expectations; typecheck passed.
- schema regeneration remained byte-stable at SHA-256 `81d501534c8e7e3fd7108ff86468848f3b6063ba042c1589fbca92c0db0e3093`; diff and trailing-whitespace checks passed.
- final independent re-review `task_c121526b89cd4b6ea767f24f24dddd1d` reran every prior reproduction, randomized Unicode helper checks, focused tests, real-broker integration, and the full suite; no actionable findings remained.
- parent verification: `bun run typecheck`, full `bun test` (1867 pass, 0 fail across 124 files), deterministic schema regeneration at SHA-256 `81d501534c8e7e3fd7108ff86468848f3b6063ba042c1589fbca92c0db0e3093`, and `git diff --check` all passed.

## ~~1. Contract and red tests~~

- add focused API/backend/CLI/schema tests for one selector resolution, stable-ID pinning, subscribe-before-send, immediate output, bounded outcome mapping, and backward compatibility.
- red recorded 2026-07-23: `bun test tests/unit/broker-backend.test.ts tests/unit/session-control.test.ts tests/unit/control-api-schema.test.ts tests/integration/api.test.ts tests/integration/broker-backend.test.ts` failed on the missing `prompt` CLI action, missing `promptSessionAndWaitForOutput` schema operation, missing `BrokerBackend.promptAndWaitForOutput`, and missing `/api/session-control/prompt` route. the same run exposed one unrelated local 1Password git-signing failure in the Ralph API test.
- supplemental boundary red: `bun test tests/unit/broker-backend.test.ts --test-name-pattern 'freezes an existing subscription boundary'` returned boundary `23` instead of the registration-time boundary `17`, proving the boundary must be captured by the subscriber registration rather than read after an awaited readiness promise.

## ~~2. Server-owned atomic operation~~

- add a stable-ID broker-backend primitive that installs output/lifecycle observation, waits for subscription readiness, sends input once, and returns a bounded typed outcome.
- expose one authenticated HTTP route that resolves the selector once and returns canonical name/ID in every operation outcome.

## ~~3. CLI and public contract~~

- add the minimal `session prompt` wrapper, generated control API schema/snapshot, and session-control docs.
- document the pre-send output boundary and the #209/#211 predicate deferral.

## ~~4. Verification~~

- focused green: 285 passed across broker client/backend, CLI, schema, API, real-broker integration, and schema-runtime contract tests; authenticated-route coverage added and separately passed 30/30.
- full green: `bun test` with local git signing disabled for test-created commits — 1854 passed, 0 failed, 1 snapshot, 4444 expectations.
- typecheck green: `bun run typecheck` completed with no diagnostics.
- generated schema/diff green: `bun run gen:schema`, `git diff --check`, and trailing-whitespace checks completed successfully.
- final status inspected on `dev_new` at `905a141`; unrelated pre-existing dirty/untracked paths remain untouched and no commit was created.
