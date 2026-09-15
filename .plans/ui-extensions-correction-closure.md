# Phase-0 corrective closure matrix

**Incomplete; phase-0 remains blocked.** This is a finding/evidence report, not
assignment state. The single current handoff is section 2 of
`docs/plans/ui-extensions-context-skill.md`. Full findings remain in the immutable
`.plans/review-ui-extensions-0f4c4e3.md`.

## Coverage and remaining work

| Finding | Regression/evidence | Result |
| --- | --- | --- |
| Schema data names/literals treated as schema keywords | `extension-correction-regressions.test.ts`: ordinary `properties.pattern`/`const.format` | Narrow repro fixed in `2587844`; full schema-position traversal/boolean schemas/byte-node-work bounds still need closure |
| Read accepts mismatched persisted key | Same file: exact hashed-key mismatch | Narrow repro fixed in `2587844`; complete persisted authority validation remains open |
| Full receipt coherence, payload size/digest, revision overflow and corruption | Not yet added | **Open** |
| Skill update deletes user-added regular file | Same file: user-added `notes.txt` | Narrow repro fixed by refusal in `2587844`; symlinks/directories/aliases/registry/frontmatter bounds remain open |
| Skill removal and fault-atomic swap/registry recovery | Not yet added | **Open** |
| Loader authority, header/body deadline, hard byte cap and cleanup | `extension-loader.test.ts`, 38 individually named/parameterized tests | Coordinator tests committed first as `d13c19b`; fixes committed as `761f2e8e001e5a12276d1291577a2ffdbde8d1f8`; **38/38 pass**, awaiting independent re-review |
| Loader CSP typo and truthful branch evidence | Corrected CSP in `extension-loader-spike.e2e.ts`; both real browsers rerun | Chromium **1/1**, WebKit **1/1**; no production integration claim |
| Archive immutable source, prompt decompression abort and extraction policy | Not yet added | **Open** |
| Canonical npm/manifest SemVer and preserved SRI error identity | Not yet added | **Open** |
| Layout malformed object typed errors | Not yet added | **Open** |
| Separate tab-only/layout-only package fixtures | Not yet added | **Open** |
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
- Broad, generated-asset budget and compiled/integration gates were **not rerun
  after this interim loader correction**. Last broad remains nonzero; the same
  release-smoke timeout independently reproduces on the original base. See the
  main handoff for exact baseline and second-review counts/logs. Full phase-0
  final-revision verification remains required after all open groups are fixed.

The loader deadline covers acquisition and digest verification. It does not
promise to stop trusted extension code or top-level await during module evaluation.
No browser-code sandbox, self-contained-JavaScript scanner, production asset
route, real-terminal retention or real-agent skill acceptance is proved here.
