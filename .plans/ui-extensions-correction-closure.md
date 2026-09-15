# Phase-0 corrective closure matrix

**Incomplete; phase-0 remains blocked.** This is a finding/evidence report, not
assignment state. The single current handoff is section 2 of
`docs/plans/ui-extensions-context-skill.md`. Full findings remain in the immutable
`.plans/review-ui-extensions-0f4c4e3.md`.

## Coverage and remaining work

| Finding | Regression/evidence | Result |
| --- | --- | --- |
| Schema positions and JSON/work bounds | `extension-document-integrity.test.ts`: boolean schemas, every supported subschema position, literal/property data, typed invalid JSON, work/byte/node limits, no async validators | Coordinator fixes `f85ddef`; final tests pass; independent re-review pending |
| Read key identity and complete receipt coherence | `extension-document-integrity.test.ts`: wrong scopes/IDs/versions/timestamps/bases/history, latest digest, canonical/physical payload caps, symlink rejection | Coordinator fixes `f85ddef`; final tests pass; independent re-review pending |
| Revision overflow, idempotency and operation snapshot | Same suite: retained window/restart, dropped-response retry after scope exit/schema upgrade, immutable input, concurrent CAS, bad clock, asynchronous scope decisions | `f85ddef` + `8183596`; backend decisions are awaited, not treated as truthy promises. Final tests pass; independent re-review pending |
| Skill update deletes user-added regular file | Same file: user-added `notes.txt` | Narrow repro fixed by refusal in `2587844`; symlinks/directories/aliases/registry/frontmatter bounds remain open |
| Skill removal and fault-atomic swap/registry recovery | Not yet added | **Open** |
| Loader authority, header/body deadline, hard byte cap and cleanup | `extension-loader.test.ts`, 38 individually named/parameterized tests | Coordinator tests committed first as `d13c19b`; fixes committed as `761f2e8e001e5a12276d1291577a2ffdbde8d1f8`; **38/38 pass**, awaiting independent re-review |
| Loader CSP typo and truthful branch evidence | Corrected CSP in `extension-loader-spike.e2e.ts`; both real browsers rerun | Chromium **1/1**, WebKit **1/1**; no production integration claim |
| Archive immutable source, prompt decompression abort and extraction policy | Not yet added | **Open** |
| Canonical npm/manifest SemVer and preserved SRI error identity | `extension-version-layout-regressions.test.ts`: standard versions including build metadata; invalid prefixes/whitespace/versions; missing SRI | Fix `6810cda`; final tests pass; independent re-review pending |
| Layout malformed object typed errors | Same suite: null/primitive/sparse inputs, bounded IDs/tracks/spans, zero/12/13 panes, selected lead, detached output | Fix `6810cda`; final tests pass; independent re-review pending |
| Separate tab-only/layout-only package fixtures | Same suite: two manifest-bound contribution gates with independent registrations; unknown kinds refused | Fix `6810cda`; final tests pass; independent re-review pending |
| Compiled asset-host and archive-extraction feasibility | Existing smoke covers AJV/SemVer only | **Open** |
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
