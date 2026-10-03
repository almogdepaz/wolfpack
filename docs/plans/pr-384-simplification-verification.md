# PR #384 simplification verification

Base: `88c5c253e2e0350fc333ea32e4c97a168cf6a550`. Implementation worktree: `/Users/almog/Dev/wolfpack-pr384-simplification`, branch `fix/pr384-simplification`; publication target: `origin/feat/ui-extensions`. Checks below ran on the final code/test content before commit (dirty working tree), with Bun 1.4.2. The later changes to these plan/receipt documents do not change executable content.

Full logs and command/identity/duration metadata are retained privately under `/Users/almog/.pi/agent/workflow-runs/<run-id>/` (`output.log`, `result.json`). Logs are not included in the commit. Counts below are outer-runner summaries, not sums including child runners.

## Final parent checks

| Check | Result | Duration | Run ID |
| --- | --- | --- | --- |
| `bun test tests/unit/ tests/snapshot/` | **2227 pass, 1 skip, 3 fail** | 258.55s | `6dc9ff8d-310b-4e63-bb9b-c8dc9587fcf2` |
| Every integration test except auth (explicit sorted file list), then isolated auth; bundle budgets; all three typechecks | **442 pass, 4 skip**, then **36 pass**; budgets/typechecks pass | 190.35s | `10647292-89d3-49e9-865a-a79478e559bc` |
| `workspace-layout-broker.e2e.ts` + `extensions-frontend.e2e.ts`, desktop + iPhone-14 Chromium | **45 pass, 37 project-inapplicable skips** | 247.74s | `00d6d5cc-1b51-4c06-8ca9-bd853cfb0722` |
| `bun test tests/e2e/test-server-broker-readiness.test.ts`; context links; diff whitespace | **1 pass**; context/diff checks pass | 7.29s | `21e91cdb-e81b-4ad0-a9aa-83e22f3250e9` |
| `WOLFPACK_BUILD_SERVER_ONLY=1 bun run scripts/build.ts`; diff whitespace | Four server platform binaries built; no broker build | 1.62s | `69051225-dcf7-453d-9600-1447afe5107e` |

Integration/browser checks used `WOLFPACK_BROKER_BIN=/Users/almog/Dev/wolfpack-pr384-ci/broker/target/release/wolfpack-broker`, from the unchanged same-head baseline worktree. SHA-256: `be71589716e5659d87640e0eb9c8b31aa40e10cf822fb31dac44edae3cc5d9c3`. No native source changed; this is not evidence of a newly rebuilt broker.

Browser assets were regenerated before tests. Independent read-only rebuild confirmed embedded app/CSS bytes and cache versions match source (`8f278489-bebd-4f7d-889c-17cdef3da962`).

## Failure and skip disposition

The broad unit/snapshot gate is **not green**. Final failures:
- Release smoke: valid archive install and rejected-signature scenarios exceeded unchanged 5s test deadlines.
- Install entrypoint: root-tar fixture's npm command exceeded its unchanged 2.5s subprocess deadline.

Both families reproduce on the untouched base:
- Baseline broad unit/snapshot: 2209 pass, 1 skip, 4 release-smoke timeouts (`2e8b085c-589f-4b07-aa77-8328c6a39a51`).
- Baseline isolated release-smoke: 1 pass, 5 timeouts (`593736f3-4108-4267-9475-6b539d82ee59`).
- Baseline isolated root-tar fixture: 1 npm timeout (`3a125d2b-874e-432d-a24d-8c82fb714215`).

These local packaging-fixture failures are not claimed fixed or silently excluded. No budgets/assertions/timeouts changed. Deployment is local/server-only, not release publication; package publication gates remain uncleared.

The unit skip is Linux-only behavior on macOS. Four integration skips require external pinned RAM/compiled-Pi prerequisites. Browser skips are project applicability, including WebKit-only cases excluded from Chromium projects. WebKit is unavailable locally; no physical-device coverage is claimed. Native Cargo/full repository E2E suites were not rerun. Expected fallback, fixture-error, shell-job-control and color-environment diagnostics remain in the logs.

## Independent final review

Reviewer found no actionable correctness regression and confirmed all prior findings resolved on identical code/test/embedded-asset hashes. This is focused review clearance, not an assertion that the broad gate is green.
- **211 focused tests pass, 0 fail/skip** plus all three typechecks: `f7e1fca3-bfec-40ad-b669-bdc55790536f` (21.31s).
- Current-bundle workspace browser rerun: **6 pass, 6 project skips**: `985393b0-f3e0-4299-93e4-08cb996d4cd5` (64.14s).
- Package/peek/polling lifecycle browser rerun: **5 pass, 0 skips**: `ff7cb2bb-cd49-4132-baaf-f73ce32eb15b` (47.62s).

The permanent area-derivation test first failed as intended with 3 calls instead of 1 (`cc09dd8e-bf1c-4f3a-879d-76eab6048e5f`). Final tests pass with one derivation, including native selection repair and collapsed peek. A transient test-only TypeScript narrowing error was corrected; the full final typecheck passes.

## Publication/deployment boundary

Commit and normal fast-forward push target PR #384's existing branch; no merge, force-push, tag or release publication is authorized. Local deployment uses `scripts/deploy-local.sh --broker=no`, preserving the running broker and exact pre-existing session identities. Deployment must verify server PID replacement, unchanged broker PID, served bundle hash, API/CLI health and session continuity. Exact commit, remote identity and deployment receipt belong in the final handoff after those operations occur.
