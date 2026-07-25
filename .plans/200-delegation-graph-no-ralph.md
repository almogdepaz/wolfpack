# #200 delegation graph/status view plan — no Ralph scope

status: implementation and review fixes complete
issue: https://github.com/almogdepaz/wolfpack/issues/200
created: 2026-07-25
implementation task: task_40df307ddc7346668f34f9d8a947fcbe (cancelled; parent took ownership after subagent closed)
implementation session: wolfpack-sub-agent-3 (closed)
delivery review task: task_394e9ff0f8f742829d4b34b0eb2343fd (protocol-blocked; finding delivered manually and fixed)
security/quality review task: task_634875975e124eefaeb1501d16fbf3dc (protocol-blocked; findings delivered manually and fixed)

## assumptions

1. This targets `origin/main` after #209 is present; local `dev_new` is behind and should not be the implementation base.
2. Ralph-specific UI/data is explicitly out of scope. Existing Ralph routes/cards stay untouched, but the delegation graph will not distinguish Ralph-created work.
3. Use the existing session identity source of truth: `/api/sessions[].identity.parentSession`, `identity.agentKind`, and `runtimeState`; do not infer hierarchy/status from names or terminal text.
4. This is a presentation/navigation issue, not new scheduling/orchestration, not a live event stream, and not persistence beyond existing session identity metadata.

## non-goals

- no `src/ralph-*`, `public/app-ralph.ts`, `/ralph`, or Ralph-card changes except avoiding regressions
- no new task scheduler or automation behavior
- no parsing terminal prose for done/blocked/parent relationships
- no new parent/child persistence model unless implementation proves current identity projection is insufficient
- no mobile attention inbox; #212 owns that

## success criteria

- desktop session list presents delegation trees clearly: parent cards with child rows underneath, not just a flat sorted list with subtle indentation
- parent cards show a compact child summary derived from canonical `runtimeState` (`needs-input`, `failed/stopped`, `done/unseen`, `working/output`, idle)
- child cards show parent context and have clear jump behavior using existing `openSession(...)`
- orphaned children with missing parents remain visible and explicit instead of disappearing or being silently reparented
- multi-machine rendering remains safe: local and peer payloads are escaped, and relationships are only within the same fetched machine group unless a future contract adds cross-machine parent IDs
- existing grid/open/kill/take-control behavior remains unchanged

## reviewer plan-gate additions

status: accepted from task_04fb186a0e9449f580a61ea9b26600ed

- focused verification must not be optional: include red/green focused tests for projection/rendering and a final typecheck attempt
- define and test exact child summary priority/count semantics: needs-input, failed/stopped, done+unseen, working/output, idle
- add escaping coverage for parent names/session names rendered through new hierarchy surfaces; HTML text and HTML attributes must use the correct escaper
- add coexistence/no-regression coverage that Ralph data/rendering is not required for the delegation hierarchy and existing Ralph cards are not modified
- regenerate browser assets after `public/**` changes
- explicitly preserve sidebar/grid button event behavior (`event.stopPropagation`, `openSession`, `toggleGrid`, `killSession`)

## 1. Confirm current contract and add hierarchy tests first

status: complete
owner: implementor subagent

- inspected current session payload shape and `public/app.ts` grouping helpers
- added focused tests around hierarchy ordering and summary projection using current parent identity fields
- covered: parent with children, child needing input, child done/unseen, orphan child, and unrelated sessions
- avoided Ralph fixtures in these tests

verification target:
- focused unit/browser test fails before UI implementation or asserts current weak rendering gap

## 2. Improve pure hierarchy projection for the browser list

status: complete
owner: implementor subagent

- kept source data as `/api/sessions`; extracted `public/delegation-sessions.ts` as a pure projection helper
- computed per-parent child summaries from `runtimeState`, with legacy `triage` only as fallback
- kept ordering deterministic: parent, attention children first, remaining children by current stable sort, then orphan/roots
- kept orphan children as visible top-level rows with explicit missing-parent context

verification target:
- pure projection tests for ordering/summary edge cases

## 3. Render delegation UI without changing session authority

status: complete
owner: implementor subagent

- updated desktop/session sidebar card markup/classes to make parent/child relationships obvious
- added compact child count/attention summary to parent cards
- added child-row affordance: parent name/context jump + runtime state badge + existing open/kill behavior
- preserved current click behavior, grid behavior, kill button event handling, escaping, and multi-machine group rendering
- left mobile behavior conservative through shared responsive CSS inheritance

verification target:
- focused Playwright/e2e or DOM rendering tests for desktop hierarchy and navigation

## 4. Update docs/schema only if public contract changes

status: complete
owner: implementor subagent

- no schema change; consumed existing `identity.parentSession` and `runtimeState`
- regenerated browser assets after source/style changes
- Ralph modules/routes/cards remained out of scope

verification target:
- `bun run typecheck`
- focused tests from steps 1–3
- full `bun test` before PR handoff if time allows

## 5. Independent review pass

status: queued after implementor result
owner: reviewer subagent

review scope:
- confirm no Ralph-specific scope slipped in
- confirm no hierarchy/status inference from human-readable terminal text
- confirm escaping remains correct for session names, project paths, parent names, and peer data
- confirm open/grid/kill/take-control behavior is preserved
- confirm tests cover missing parent/orphan and runtime-state summary cases

review output:
- verdict: ship / needs changes
- actionable findings only, each tied to a file and failing behavior/risk

## subagent workflow

1. Parent waits for user approval before implementation.
2. Parent dispatches implementor subagent with this plan as `contextRefs`, issue `#200`, role `implementor`, verification tier `focused+full-if-feasible`.
3. Implementor edits code/tests only for this issue and finishes with `agent_task_done` including changed files and verification.
4. Parent inspects diff, then dispatches reviewer subagent with the plan and implementor diff context.
5. Parent applies or delegates fixes one finding at a time, then reports verification evidence.
