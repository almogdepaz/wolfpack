# Phase-0 corrective closure matrix

**Acquisition correction implemented; follow-up verification/approval pending. All other prior finding groups are closed. Phase 0 is not approved.** This is a finding/evidence report, not
assignment state. The single current handoff is section 2 of
`docs/plans/ui-extensions-context-skill.md`. Full findings remain in the immutable
`.plans/review-ui-extensions-0f4c4e3.md`.

## Acquisition correction after the independent review

Code `a761a0f22f15b365fd6be6ebcbc835efecca903e` selects bounded native Fetch instead
of external npm. This removes both unbounded child calls, npm version preflight,
cache/config side effects and package-manager disk writes. The async helper has
one reducible 30-second deadline, 256-KiB metadata cap, 32-MiB pre-write tarball
cap, matching package/SRI authority, owner-private staging, and typed cancellation
and cleanup. It supports anonymous same-origin registries, not npmrc/private
registry/CDN authentication. Local loopback is for isolated fixtures.

- Test-first contract `072537d6ac0d89a4ec895c00362e6ce16bf9ce96`: 19 new
  async-transport cases initially failed (`e8f7d649-af8a-4bc2-b66f-1a30d6fdeaa0`).
  Those are new-API contract failures; the independent old-executor deadline and
  bad-version probes below remain direct evidence of the original defects.
- Initial correction: **60 tests passed**, then typecheck failed on overly broad
  option narrowing (`e611b4c5-7641-4e40-86a4-73046c7ae7fe`). Narrowing fixed.
- Focused **282 pass / 0 fail / 0 skip**, typecheck/context and native smoke passed
  (`969f78bf-fb8d-4450-99ca-74eadc3ef802`). The compiled executable uses real Fetch
  against a local fixture registry, acquires/verifies/extracts a harmless package,
  rejects an oversized acquisition and checks cleanup, with poisoned npm and
  lifecycle-script markers proving neither ran. Tests never contact a real registry.
- A small late-response elapsed-deadline check was included after that run. The
  final frozen revision reran all required gates below; earlier results are not
  reused as final approval. No unrelated feature/security-nit expansion is in scope.
- Exact clean **`41d7f3a69144f14c24434af2a91fe2dccf6b5bb9`**: combined final gate
  `6e593b04-14f9-40ba-b28b-2bf2abbbfcc4` passed in 26.818s: **282 focused pass**,
  typecheck/context, compiled actual offline acquisition and extraction, Chromium
  **2/2**, WebKit **2/2**, generated assets/budgets. Only browser color warnings.
- Same-candidate broad `94dcdad0-756a-4a75-90f4-63f45e06c6c4` exited **1**,
  128.741s: top-level **2040 pass / 1 skip / 1 fail**, 2042 tests in 179 files.
  The failure is the unchanged 5000ms release-smoke timeout; the skip is the Linux
  no-controlling-TTY fixture on macOS. Do not use nested aggregate 2057, erase the
  failure, or expand this correction into the baseline smoke scripts.
- Reviewer dependency preflight at the same clean candidate passed
  (`0e04d211-d07a-491e-9071-37d41b467c83`); this is not test coverage.

## Previous independent final disposition at `34fec6e`

The immutable `.plans/review-ui-extensions-34fec6e.md` closes the prior
loader/schema/receipt/skill/archive-byte/SemVer/layout/contribution/compiled-host
findings. One **P1** remains: external npm acquisition lacks finite child deadlines
and download-time disk bounds; version preflight accepts arbitrary success output;
the compiled smoke never executes the acquisition helper/system npm. Both child
calls need bounded output and deterministic timeout cleanup. An owner-private
acquisition mechanism must cap bytes before/during download, not only afterward.
Correct this with failing-before tests and actual compiled local-fixture execution;
real registry acceptance remains a separately authorized gate.

Parent read the entire final report, checked clean exact reviewer source, confirmed
implementation changes since that candidate are documentation-only, and inspected
the deadline/version probes and independent closure/broad logs. Matching copied
report SHA-256: `55d9c42b7336fcbeaafe46fe16a11872344f36f1e3a719e53c242ff13e64de32`.

Independent verification (full command/revision metadata in the report): focused
**263/263** (`d676af83-e8ff-4664-9555-6c22f8ea90aa`), typecheck/context, compiled
foundation, Chromium **2/2**, WebKit **2/2**, generated assets/budgets and closure
probe all passed. Broad `8c73174f-d67c-495d-857e-d3d5502740f7` passed with final
top-level **2022 pass / 1 skip / 0 fail**, 128.72s; not the nested aggregate 2039.
The parent's earlier **2021/1 skip/1 timeout** remains a genuine failed run.
Version-preflight probe `8db7f834-d1b9-4ea3-aa61-9d33427280e4` and child-deadline
probe `4ef7bc0a-cc84-408c-813a-5ba638cd72b0` both fail correct-behavior assertions.
Reviewer setup/comparator failures and corrected runs remain recorded in the final
report; none was suppressed or attributed to source incorrectly.

### Historical coordinator evidence before final independent review

The pending-review labels in this historical table are superseded by the final
disposition above, not unresolved findings to reopen.

| Finding | Regression/evidence | Result |
| --- | --- | --- |
| Schema positions and JSON/work bounds | `extension-document-integrity.test.ts`: boolean schemas, every supported subschema position, literal/property data, typed invalid JSON, work/byte/node limits, no async validators | Coordinator fixes `f85ddef`; final tests pass; independent re-review pending |
| Read key identity and complete receipt coherence | `extension-document-integrity.test.ts`: wrong scopes/IDs/versions/timestamps/bases/history, latest digest, canonical/physical payload caps, symlink rejection | Coordinator fixes `f85ddef`; final tests pass; independent re-review pending |
| Revision overflow, idempotency and operation snapshot | Same suite: retained window/restart, dropped-response retry after scope exit/schema upgrade, immutable input, concurrent CAS, bad clock, asynchronous scope decisions | `f85ddef` + `8183596`; backend decisions are awaited, not treated as truthy promises. Final tests pass; independent re-review pending |
| Skill inventory/frontmatter/registry and full owned-tree comparison | `extension-skill-safety.test.ts`: portable aliases, YAML fields/bounds, coherent registry, missing/edited/untracked files, modes, symlinks and empty directories | `7ed6674`; coordinator verified, independent re-review pending |
| Skill removal and fault-atomic swap/registry recovery | Same suite: removal ownership, stage/swap/registry faults, post-commit errors, parked edits, failed rollback, no-op I/O, locking/cleanup | `7ed6674` + `d4561ec`; 61 safety cases, independent re-review pending |
| Loader authority, header/body deadline, hard byte cap and cleanup | `extension-loader.test.ts`, 38 individually named/parameterized tests | Coordinator tests committed first as `d13c19b`; fixes committed as `761f2e8e001e5a12276d1291577a2ffdbde8d1f8`; **38/38 pass**, awaiting independent re-review |
| Loader CSP typo and truthful branch evidence | Corrected CSP in `extension-loader-spike.e2e.ts`; both real browsers rerun | Chromium **1/1**, WebKit **1/1**; no production integration claim |
| Npm acquisition child/disk bounds and supported preflight | Reviewer deadline probe `4ef7bc0a-cc84-408c-813a-5ba638cd72b0`, independently inspected alongside source | **Open:** no subprocess timeout, download disk cap only after return, unvalidated version output and no compiled acquisition execution proof. Timeout alone is insufficient for disk bounds |
| Archive immutable source, prompt decompression abort and extraction policy | `extension-archive-safety.test.ts`: 43 cases; bounded independent gzip stream, aliases/types/metadata, SRI and pathname replacement, private output, injected write/cleanup failure | `d4561ec`; coordinator verified, independent re-review pending |
| Canonical npm/manifest SemVer and preserved SRI error identity | `extension-version-layout-regressions.test.ts`: standard versions including build metadata; invalid prefixes/whitespace/versions; missing SRI | Fix `6810cda`; final tests pass; independent re-review pending |
| Layout malformed object typed errors | Same suite: null/primitive/sparse inputs, bounded IDs/tracks/spans, zero/12/13 panes, selected lead, detached output | Fix `6810cda`; final tests pass; independent re-review pending |
| Separate tab-only/layout-only package fixtures | Same suite: two manifest-bound contribution gates with independent registrations; unknown kinds refused | Fix `6810cda`; final tests pass; independent re-review pending |
| Compiled asset-host and archive-extraction feasibility | Native empty-CWD host with real browser loader/runtime assets; native schema/store/SemVer/YAML/skill/tar operations | `a009ea8` + `d4561ec`; expanded native smoke and both browser projects passed at `34fec6e`; independent re-review pending |
| Contradictory/overstated docs | Corrected 12-pane bound, WebKit status, removed scanner/atomic-removal claims; explicitly documented current gaps | Current assertions narrowed, but final contract freeze/review remains open |

## Exact verification evidence

All logs/commands are owner-private under
`/Users/almog/.pi/agent/workflow-runs/<run-id>/` (`output.log`, `result.json`).

- Parent verification of partial failed-delegation commit, clean HEAD
  `99e928a3d253d3819de9673c742eb21a2ab44ab1`: **3 pass / 0 fail / 0 skip**,
  `fd910b7e-4eed-4f05-b480-8dc9dd49199e`.
- Loader test-first red run: production source at
  `d7e29395a3962b6d80d0da781cec62eb563057c1`, new test file untracked at execution
  and then committed unchanged as `d13c19b10b04838c3adde97d190cd7b9c3fc0bdc`:
  **11 pass / 27 fail**, exit 1, `cf090e7e-20eb-4d4d-8801-dedf9538d096`.
  Invalid timeout inputs also caused a runtime warning in the old code.
- First implementation green run: **38 pass / 0 fail**, typecheck passed,
  `91c5e99b-1294-49d4-8ad9-e260d61cd436`. A subsequent bounded-memory refinement
  was verified again below; this earlier run is not the latest-source evidence.
- Final loader-source verification before commit `761f2e8`:
  `bun test tests/unit/extension-*.test.ts` **52 pass / 0 fail / 0 skip**, followed
  by typecheck, context links, desktop browser **1/1**, mobile WebKit **1/1**,
  all commands exit 0. Run `df8c6bbf-8d55-44b3-bc9a-fd5046112293` recorded
  HEAD `d13c19b` with dirty loader/fixture/contract files; those exact edits were
  committed as `761f2e8`. Playwright emitted NO_COLOR/FORCE_COLOR warnings only.
- Those were interim loader-only results. Newer coordinator evidence follows;
  it does not constitute phase-0 approval or full integration coverage.

## Coordinator schema/receipt/version/layout correction

- Test-first document commit `71e5900`: initial **18 pass / 44 fail**,
  `97685648-c6fe-418e-a16a-6b8f893444c2`. Fix `f85ddef` adds bounded plain JSON,
  schema-position policy, strict record/receipt validation and immutable requests.
  Early combined run `76a556d9-6505-4893-b34e-f41dd37049c7` had **68 tests pass**
  but typecheck FAILED on the test helper's error-code annotation; annotation fixed.
- Extra audit probes `8016210c-12d5-4587-b059-6cec46e4fd1e` included an incorrectly
  undersized quadratic-work fixture. Corrected fixture run
  `fc45b0ac-434d-4e42-9144-9d34eb984868`: **1 pass / 2 fail**, 62 filtered,
  exposing async schema and unawaited scope-check hazards. Async schemas are
  rejected; live-scope hooks instead support correct awaited backend decisions.
- Correct version/layout test-first commit `e019df5`: **18 pass / 22 fail**,
  `c410609b-5069-4ed2-b8f7-e7c5b7d255c6`. Earlier `46dc5ab6-287b-4900-b37d-03165a474125`
  had incorrectly expanded array parameters and is not the authoritative red
  run. Extra sparse-array repro `dc1a77ff-b150-464a-b4ef-9437e017977b`:
  **40 pass / 1 fail**; fixed by visiting holes rather than skipping them with map.
  Intermediate `0a633c8d-cf3d-4596-9384-e841652577ec` had **158 tests pass** but
  typecheck FAILED on an unnecessary negative-test cast; fixed before `6810cda`.
- At clean `6810cda`, focused **158/158**, typecheck/context and compiled AJV/SemVer
  smoke passed (`358bab27-e3a2-4232-ab6f-a9aea3cd330d`). Broad
  `accfb4af-d83b-451e-a286-afe5547041a1` FAILED: top-level **1916 pass / 1 skip /
  1 release-smoke timeout**. No release-smoke source or timeout was changed.
- Async scope support refinement `8183596` was preceded by two failing tests
  (`1427978b-179c-475b-ad76-a4cfd11c1032`). A subsequent combined run
  `a26c608a-b1b1-43bd-a346-f3efb8527a30` TIMED OUT in the new test harness:
  Bun's rejection matcher waited before the test released its pending decision.
  No final test count or downstream check completion is claimed for that run.
  Test-only sequencing fix `c03fd94`; targeted **2 pass**, 64 filtered,
  `532588a9-ab39-491a-9022-1ed2e1d00066`.
- Latest exact tested tree: **`36aa1a40b30ce3ab32206acd69b584acd1fc179b`**, clean.
  Run `8268fdb6-bff9-40fe-8454-c3182b24a936`: **159 focused pass / 0 fail / 0 skip**;
  typecheck/context passed; isolated compiled AJV/SemVer smoke passed outside
  checkout; Chromium **1/1**, WebKit **1/1**. Only Playwright color-environment
  warnings. Native compiled asset-host and tar-extraction proofs remain open.
- Latest broad at that same clean tree: `b8c98f29-13aa-409b-b307-fc5dd31ab3a3`,
  exit **0**, 127.144 s, top-level **1918 pass / 1 skip / 0 fail**, 1919 tests in
  176 files. The runner's aggregate 1935 includes nested summaries; use 1918.
  Skip: Linux no-controlling-TTY install fixture on this macOS host. Logged
  test-warning diagnostics remain retained. The intermittent baseline smoke
  timeout did not recur; this is not an extension fix or erasure of earlier failures.
- Generated-assets budget, full native/integration gates and real-agent acceptance
  have not been rerun/completed for these changes. Full final-revision phase-0
  verification/re-review is required after remaining skill/archive/compiled gaps.

The loader deadline covers acquisition and digest verification. It does not
promise to stop trusted extension code or top-level await during module evaluation.
No browser-code sandbox, self-contained-JavaScript scanner, production asset
route, real-terminal retention or real-agent skill acceptance is proved here.

## Coordinator skill/archive and native feasibility correction

- Skill test-first `d4c3f39f52492d0c3d6816c123b4f0d287541cfb`: source still at
  `99dce31`, initial 50-case run **9 pass / 41 fail** (`f1a69b24-aff2-456c-978b-5205afc8f6e2`),
  expanded 53-case run **8 pass / 45 fail** (`f3672147-facf-4e74-932b-8a5b8f4ebd30`).
  YAML 2.8.2 was added exactly, with install scripts disabled, in this worktree only.
- Initial implementation plus existing skill/correction tests: **57 pass**, typecheck
  passed (`58d5420e-f3ab-413b-9adb-58ad94b941ff`). Six extra probes then produced
  **54 pass / 5 fail** (`3aead7e1-297c-4190-8a7d-54c03a2d6264`): sparse/oversized batches,
  changed root modes, silent registry no-op, and late parked-tree edits. The pre-commit
  parked-edit case already passed. Fix `7ed6674853bcaeb94cbbb1c40be049e177cd81b4`:
  full focused **218 pass**, typecheck/context passed (`fd9b59a6-2a67-4348-a5d9-51b6dbe7b239`).
- Compiled feasibility `a009ea8b4f2b29f6bc544f785bea9af1292680b0` adds actual
  schema/store/SemVer/YAML/skill/tar calls, plus a separate native fixture hosting
  the browser loader and authenticated runtime package assets from an empty CWD.
  Intermediate `a6b7fc83-e6f7-4d44-903b-790a634c87d6`: **218 tests pass**, typecheck
  failed on a too-wide Buffer return annotation. Fixed without a cast. Run
  `f796c672-6604-4385-bda3-b6e3a6b8cdc9`: typecheck/context/native smoke passed,
  Chromium failed on macOS `/var` versus `/private/var` fixture CWD spelling.
  The fixture now canonicalizes its owned temp root. Run
  `2dbe70fb-b0a3-4e8a-b559-814a47823e1d`: Chromium **1/1**, WebKit found no tests
  because its allowlist omitted the new fixture. Both the file and named test
  were added to that project. Then **Chromium 1/1, WebKit 1/1** passed
  (`ea9119a5-7a2d-4bd3-abd2-37b21bf313ae`); color-environment warnings only.
- Archive test-first `97643557350d6fbf9ec46cff58dd0673f1a311e0`: **13 pass / 28 fail**
  (`0633c702-843b-4e6a-9051-05a5237da503`). Initial implementation exposed a fixture
  defect: `tar.Header.encode()` truncates long paths unless its required PAX record
  is emitted (**83 pass / 1 fail**, `0cfea1fe-4ac4-4e33-802e-8e208c38d73f`).
  Fixed the fixture to emit maintained `tar.Pax`, not relaxed path assertions.
  Next **84 tests passed**, typecheck failed on stream-option/Buffer annotations
  (`1bc1b734-5677-41be-b18a-dec112c12092`); both fixed.
- Additional archive cleanup-no-op probe: **42 pass / 1 fail**
  (`6a2dc5b5-0643-4174-9d11-ddabec056756`). Analogous skill rollback/cleanup
  no-op probes: **0 pass / 2 fail**, 59 filtered (`fe1b5ee1-627e-4adb-9d90-9ac141c6b984`).
  Fixes read back observable filesystem state before cleanup/success reporting;
  failed rollback never deletes a still-parked old tree.
- Authoritative corrected-fixture archive baseline: exported unchanged source
  `a009ea8` into a private temp tree with the final 43-case suite and the same
  installed dependencies. **13 pass / 30 fail**, `5696fbc8-9cd4-4024-821a-e30a50527acd`.
  Temp tree was removed; neither the original checkout nor implementation source
  was reset/mutated for this baseline probe.
- Code correction `d4561ec8bf15cb708b621ff54a1dc7d9726feef6`: immediately preceding
  focused run **263 pass / 0 fail / 0 skip**, typecheck/context and actual native
  foundation smoke passed (`b5a7527d-69ee-498c-a94c-9fa886047819`). This commit also
  extends the native smoke with quota rejection and pathname-replacement/SRI
  assertions; the final gate must run that expanded smoke, both browser fixtures,
  generated assets/budget and broad unit/snapshot tests on the final candidate.

## Frozen-candidate final coordinator gate

Exact clean revision **`34fec6e8851b53fc06319c79e8f418da5cffbbc2`**:

- `6cbeaff5-efd8-4615-b2e8-71ddf030525a`, exit **0**, 26.909s: **263 focused pass /
  0 fail / 0 skip**; typecheck/context; expanded native smoke including quota
  rejection and SRI/pathname replacement; Chromium **2/2**; WebKit **2/2**; assets
  generated from a private exact-revision export and bundle budgets passed.
  App: 331067 raw/81296 gzip bytes; Ghostty: 643371/187737; CSS: 96978/17005.
  Only browser NO_COLOR/FORCE_COLOR warnings. Temporary builds/hosts were cleaned.
- `0b6be1aa-eae7-4261-ad75-c029ae64f430`, exit **1**, 131.238s: broad unit/snapshot
  final top-level **2021 pass / 1 skip / 1 fail**, 2023 tests across 178 files.
  Failure: release artifact smoke's unchanged first-test 5000ms timeout.
  Skip: Linux no-controlling-TTY fixture on macOS. Use 2021, not the runner's
  aggregate 2038 containing nested summaries. Full warning diagnostics retained.
- `6ccd8267-e603-4689-a136-f3abdab1c21d`, exit **0**, 16.578s: isolated same-revision
  release smoke **6/6 pass**. This does not replace the failed broad gate. The same
  timeout was independently reproduced on original runtime-base source earlier;
  no timeout increase, test disabling or unrelated source fix was made.
- Reviewer worktree alone advanced to the same frozen candidate. Its dependency
  preflight `84a2f2a5-f607-4b38-91e1-7b16327fa939` passed the frozen/script-disabled
  install with a clean source tree. Installation is not test coverage.

These are coordinator closures, not independent approval. The implementation's
subsequent changes are handoff/contract/closure evidence only; review source stays
frozen at `34fec6e`. See the single phase handoff for current assignment state.
