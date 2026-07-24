# issue 209 — canonical agent runtime state

## assumptions i'm making
1. existing `AgentStatusState` is the canonical status enum to extend; legacy values stay valid for backwards compatibility.
2. `/api/sessions` will expose a new `runtimeState` projection while retaining `triage` for old clients.
3. session identity `wolfpackSessionId` is the run identity for terminal sessions; structured status files may optionally include `runId` and monotonic `runSequence`/`transitionSequence` to prevent older-run overwrite.
4. fallback activity is based only on structured facts wolfpack already has: broker list success, broker-authoritative membership, and raw pty byte equality since the last poll. terminal prose content is never parsed for semantic states.
5. acknowledgement state is global, server-owned, and persisted under wolfpack state path with an env override for tests.
6. generated control schema docs/snapshots are updated only from the schema source.

## success criteria
- one effective runtime state per active session includes state, source, authority, freshness, changedAt, transitionSequence, acknowledgedAt, acknowledgedSequence, and unseen.
- broker liveness gates state: unavailable => unknown, dead => off, alive permits structured/fallback derivation.
- unsupported fallback can only produce output/idle/off/unknown.
- lifecycle/manifest can produce semantic states only when declared capabilities permit it.
- old-run/older-order structured signals cannot overwrite current run state.
- ack survives store reload and becomes unseen after a newer transition.
- API/schema/UI consumers use the canonical projection while old triage remains deterministic.

## tdd log
- [x] red: domain reducer precedence/freshness/run-order/unsupported-output tests — `bun test tests/unit/agent-runtime-state.test.ts` failed on missing runtime module before implementation
- [x] green: minimal reducer implementation — focused unit now passes
- [x] red: persistence/ack restart/invalidation tests — covered in the same red run before store existed
- [x] green: persisted state store + ack behavior — focused unit now passes
- [x] red: api/schema/ui consumer tests — failed on missing schema operation/fields and absent runtimeState route wiring
- [x] green: route/schema/ui wiring — focused suite passes with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/unit/agent-runtime-state.test.ts tests/integration/api.test.ts tests/unit/control-api-schema.test.ts`
- [x] verification: focused tests, typecheck, schema generation check, full test suite
  - focused: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/unit/agent-runtime-state.test.ts tests/integration/api.test.ts tests/unit/control-api-schema.test.ts tests/unit/taxonomy-ownership.test.ts` => 146 pass
  - typecheck: `bunx tsc --noEmit -p .` and `bunx tsc --noEmit -p public/` => ok, 0 bytes output
  - generation: `bun run gen:schema` hash stable `466cada6...` before/after
  - full: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` => 1834 pass, 21 skip, 0 fail

## review round 1
- [x] PR222-BLOCK-001 generated assets stale — `bun run scripts/gen-assets.ts` reproduced deterministic generated diff in `src/public-assets.ts`; second generation hash stable `5c85f671...`
- [x] PR222-BLOCK-002 structured ordering/ack invalidation — red: same-state higher sequence stayed `transitionSequence: 1`; lower sequence overwrote to `done`; green: focused reducer tests pass
- [x] PR222-BLOCK-003 first/restored fallback false output — red: first/restored snapshots returned `running`/`output`; green: focused API regressions pass
- [x] PR222-BLOCK-004 broker unavailable/dead route projection/pruning — red: unavailable route 500/pruned path and dead session stayed fallback idle; green: focused route regressions pass, full `tests/integration/api.test.ts` 127 pass
- [x] PR222-NB-001 peer status sanitization — addressed surgically with nested contract validation; red invalid peer status passed through, green `tests/unit/peer-validation.test.ts` 11 pass
- [x] verification: focused per finding, typecheck, deterministic schema/assets, diff check, full suite, self-review
  - focused: `WOLFPACK_TEST=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/unit/agent-runtime-state.test.ts tests/integration/api.test.ts tests/unit/peer-validation.test.ts tests/unit/control-api-schema.test.ts tests/unit/push.test.ts tests/unit/taxonomy-ownership.test.ts` => 199 pass
  - typecheck: `bunx tsc --noEmit -p .` and `bunx tsc --noEmit -p public/` => ok, 0 bytes output
  - schema deterministic: `bun run gen:schema` hash stable `466cada6...`
  - assets deterministic: `bun run scripts/gen-assets.ts` hash stable `5c85f671...`
  - diff check: `git diff --check` => ok
  - full: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` => 1842 pass, 21 skip, 0 fail

## review round 2
- [x] PR222-R2-BLOCK-001 runOrder-only sequence reset — red: runOrder 2 / signalSequence 1 stayed old runOrder 1 / sequence 5; green: runOrder-only focused + full reducer tests pass
- [x] PR222-R2-BLOCK-002 cold broker-unavailable persisted projection — red: cold unavailable returned `sessions: []`; green: legacy persisted state projects as broker unknown and authoritative recovery prunes
- [x] verification: prior round regressions, typecheck, deterministic schema/assets, diff check, full suite, self-review
  - focused: `WOLFPACK_TEST=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/unit/agent-runtime-state.test.ts tests/integration/api.test.ts tests/unit/peer-validation.test.ts tests/unit/control-api-schema.test.ts tests/unit/push.test.ts tests/unit/taxonomy-ownership.test.ts` => 203 pass
  - typecheck: `bunx tsc --noEmit -p .` and `bunx tsc --noEmit -p public/` => ok, 0 bytes output
  - schema deterministic twice: `bun run gen:schema` stable `466cada6...`
  - assets deterministic twice: `bun run scripts/gen-assets.ts` stable `5c85f671...`
  - diff check: `git diff --check` => ok
  - full: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` => 1846 pass, 21 skip, 0 fail

## review round 3
- [x] PR222-R3-BLOCK-001 production broker-dead sessions filtered before route off projection — red: BrokerBackend lacked authoritative facts method and route returned `sessions: []` when live-only list omitted a dead fact; green: backend facts retain alive:false and `/api/sessions` projects off/preserves ack until omission
- [x] verification: prior runtime/order/baseline/unavailable/peer tests, broker-backend tests, route/API tests, typecheck, deterministic schema/assets, diff check, full suite, self-review
  - focused: `WOLFPACK_TEST=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/unit/agent-runtime-state.test.ts tests/integration/api.test.ts tests/unit/peer-validation.test.ts tests/unit/control-api-schema.test.ts tests/unit/push.test.ts tests/unit/taxonomy-ownership.test.ts tests/unit/broker-backend.test.ts tests/unit/broker-ws-attach.test.ts` => 298 pass
  - broker integration: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/integration/broker-backend.test.ts` => 0 pass, 8 broker-binary-gated skips, 0 fail
  - typecheck: `bunx tsc --noEmit -p .` and `bunx tsc --noEmit -p public/` => ok, 0 bytes output
  - schema deterministic twice: `bun run gen:schema` stable `466cada6...`
  - assets deterministic twice: `bun run scripts/gen-assets.ts` stable `44d62bb4...`
  - diff check: `git diff --check` => ok
  - full: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` => 1849 pass, 21 skip, 0 fail

## status
- 2026-07-25: worktree created from refreshed main at `/private/tmp/wolfpack-209-canonical-agent-runtime-state`, branch `209-canonical-agent-runtime-state`.
- 2026-07-25: review round 1 assigned from PR review https://github.com/almogdepaz/wolfpack/pull/222#pullrequestreview-4777269871.
- 2026-07-25: review round 2 assigned from PR review https://github.com/almogdepaz/wolfpack/pull/222#pullrequestreview-4777377563.
- 2026-07-25: review round 3 assigned from PR review https://github.com/almogdepaz/wolfpack/pull/222#pullrequestreview-4777482625.
