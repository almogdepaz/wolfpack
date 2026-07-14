terminal flicker investigation plan

- status: completed — root cause and review regressions fixed and verified locally; source is ready to commit
- working branch: `dev07` at merge commit `3b83088`
- branch matrix: `main` at `115232d`; pre-merge `dev07` at `fc94d22`; pr #176 at `bedb118`; merged `dev07 + #176` at `3b83088`
- integration status: pr #176 is already merged into `dev07` as merge commit `3b83088`; treat its two parents as independent comparison revisions, not pending integration work
- scope: visible terminal/session UI flicker on desktop and mobile, especially session switching, reconnect, resize, and grid transitions
- artifact directory during investigation: `/tmp/wolfpack-flicker/`
- constraint: no production fix until a repeatable symptom, first divergent event, and falsifiable root-cause hypothesis exist

assumptions:
- “flicker” means a stale terminal frame, blank frame, loading-overlay flash, opacity/visibility flash, or wrong-session frame.
- `dev07` must be compared against the same browser, settings, broker state, sessions, network profile, and interaction sequence as `main`.
- pr #176 is a separate experimental variable; it must not be folded into the baseline silently.

success criteria:
- classify the exact visual defect and produce a deterministic or statistically quantified reproduction.
- identify the first state/timing divergence between working and failing runs.
- confirm one root cause with a minimal experiment.
- add a browser regression that fails before the fix and passes after it.
- verify the fix without regressing hydration, scrollback, reconnect, resize, grid, or pr #176’s mobile behavior.

execution log:
- verified worktree/branch at `dev07` / `3b83088`; merge parents are `fc94d22` and `bedb118`.
- inspected terminal rendering history before experimentation. prior flicker fixes include `fe9359f` (hide old canvas before teardown), `7275e8b` (allow loading paint before desktop teardown), and `6fb2d93` (avoid blank-frame resize hiding).
- hashed revision sources: `main` (`115232d`) and pre-merge `dev07` (`fc94d22`) have identical `public/app.ts`; pr #176 (`bedb118`) and merged `dev07` (`3b83088`) have identical `public/app.ts`. this reduces the client branch matrix to pre-#176 versus #176 while retaining broker/runtime comparisons separately.
- repo instructions reference `edc-context/index.md` and `manifest.json`, but this worktree contains only `edc-context/reports/ux-edgecases.md`; source/history/tests are being used as the available evidence.
- completed the required merge-base inventory after inspecting the exact first-parent log, left/right cherry-pick log, name/status, stat, full 5,011-line committed diff, all four commit diffs, status, uncommitted state, ignored generated/build state, and generated provenance. detailed report: `/tmp/wolfpack-flicker/dev07-vs-main.md` (sha-256 `cc86e78efa821a53da24bfed67bc79fa6d9ce39c3af74458989b5f4354c6d886`). all 64 changed paths are individually accounted for.
- relevant deltas retained for experiments: #176 mobile switch `full` prefill; edc broker subscribe/live-handoff bookkeeping; broker dimension validation under resize; #177/edc generated app-bundle composition as a load/long-task control; installed/served cache identity.
- ruled out by direct diff/hash inspection for passive terminal switching: CSS opacity/visibility and terminal loading styles, Ghostty bundle/version, dependency lock, HTML script/style ordering, hydration controller/constants, grid transition source, snapshot renderer, Rust terminal reflow, output coalescing, prefill chunking/delivery, and server `prefill_done` emission. Ralph/push/API/persistence/input-flood/release/test/doc deltas require separate feature or fault conditions and are recorded with that rationale in the inventory.
- controlled revision matrix selected from the inventory: `115232d` (main), `a27ebcc` (#177 only), `fc94d22` (#177 + edc, no #176), `bedb118` (#176 only), `3b83088` (merged), plus current uncommitted-state identity verification. deterministic mocked-WS runs precede real-broker m0/m2/m4 runs.
- deterministic slow-prefill probe (cold + warm iPhone 14, frame sampling, screenshots/video, debug trace) isolated the first branch divergence to `attach.send.prefillMode`: m0/m1/m2 use `viewport`; m3/m4 use `full`. #177 and edc do not change incidence within their mode.
- confirmed root cause: the hydration `maxPendingMs` safety valve overrides the same `canFinish` gate that represents both protocol completion and write quiescence. with #176's streaming full prefill, a >4s transfer emits `hydration.maxPendingHit` → `hydration.finish` → `hydration.reveal` around 4.0s before `prefill_done` around 5.0s, visibly exposing partial terminal content for ~0.8–0.9s in both cold and warm runs. no blank frames or causal long task occurred.
- regression-first proof: real-browser test `full session switch and reconnect keep partial prefill hidden until prefill_done` fails on causal #176 `bedb118` and merged `3b83088` mobile switches with an early reveal; it passes on known-good pre-merge `fc94d22` mobile viewport switching. the desktop variant also proved the latent full-prefill bug existed before #176. a second red checkpoint proved reconnect reused stale protocol-complete state and revealed `live`/visible before `prefill_done`.
- minimal source fix: split protocol completion from soft write-quiescence in the hydration controller. `maxPendingMs` may still bound high-throughput write settling, but cannot override incomplete initial content. reset protocol completion from the socket client's per-attach lifecycle callback so initial attach, reconnect, resize reattach, and control-granted reattach share one source of truth.
- measured incidence for a 4.5–5s deterministic full prefill, 30 runs per cohort/profile: merged pre-fix desktop cold 29/30, desktop warm 30/30, mobile cold 30/30, mobile warm 30/30; fixed desktop/mobile cold/warm 0/30 in every cohort. fixed frame probes reveal only after `prefill_done` with zero blank frames and zero live frames before completion.
- pr #176 remains independently compatible: its mobile scrollback/touch regression passes, and full prefill remains enabled on switched mobile sessions; the fix changes only reveal gating.
- live/cache identity check before the fix: port 18790 served bundle `2e138a9df9a6425af09a085504bc161773d258744c4fdd9b37353f69d9fe4d1e`, exactly the merged `3b83088` bundle, with `Cache-Control: no-cache`; deployment/cache mismatch was falsified. installed server sha-256 is `afd30651cf22bc27e19df761e4f8e962186b04b781e0daad196c0f968a3512e6`; installed broker is `6fa7de1d3ff62cf87ad5d7d1e07c10a62985c7cd3117f0757bc8e59a3a5912a0`. both are ad-hoc signed. no deployment was performed.
- final undeployed fixed identities: generated/embedded app bundle `6e8a2cd7833b104bf6518c1ad8c14de5cca860270e93197a24473fa01453cd7c`; `src/public-assets.ts` `1fa5baf230508a86094b535ce70bb1b256a31570ca3d7c28be162a94759debb4`. regeneration is byte-deterministic.

known evidence:
- pre-merge `dev07` (`fc94d22`) does not modify `public/app.ts`; current merged `dev07` does via #176's mobile switch prefill override.
- outside #176, the browser-facing delta is primarily Ralph UI, push-unsubscribe state, generated assets, and `public/index.html`; broker/runtime changes were tested separately for timing effects.
- the repository already exposes hydration/WS/rAF diagnostics through `localStorage.wolfpackDebug = "1"` and `window.__wf_dumpTrace()`.
- pr #176 changes mobile session switches from viewport prefill to full prefill and adds a mobile scrollback test. it may change hydration duration and is present in current `dev07` via merge commit `3b83088`.

## 1. Define and capture the symptom
- obtain the precise trigger: device/browser, solo or grid, session switch/open/reconnect/resize, cached snapshot state, scroll position, and whether the flash is blank, stale, loading UI, or wrong-session content.
- record short videos plus before/during/after screenshots with the build sha, served bundle sha, viewport, device scale factor, settings, and active session count attached.
- classify each occurrence by visible layer: terminal canvas, cached placeholder, hydration/loading overlay, sidebar/layout, or entire document repaint.
- establish a measurable failure predicate, such as “canvas becomes visible before hydration reveal,” “live canvas returns to opacity 0,” or “old-session pixels remain visible after switch begins.”

## 2. Build a controlled branch comparison
- create isolated, freshly generated builds for `main`, `dev07`, pr #176, and a throwaway `dev07 + #176` candidate; serve them on separate ports without replacing the installed service.
- clear service workers, HTTP cache, local storage, and cached snapshots between cold-cache trials; run a second explicit warm-cache cohort instead of mixing states.
- replay identical deterministic WebSocket sequences for viewport/full prefill, delayed chunks, replay-after-prefill, reconnect, and long scrollback using the existing Playwright infrastructure.
- run at least 30 repetitions per high-signal scenario on desktop Chromium and the affected mobile viewport, reporting occurrence count and transition latency rather than “looked fine.”
- stop expanding the matrix once the smallest branch/condition pair that changes incidence is isolated.

## 3. Trace the first divergent frame and rank hypotheses
- enable `wolfpackDebug` and collect attach events, WS frame timing, write completion, `prefill_done`, hydration finish/reveal, and rAF counts for matched good and bad runs.
- add test-only observation of `data-terminal-load-state`, `hydrating`/`hydrated`/`transitioning`, canvas visibility/opacity, DOM replacement, resize events, and long tasks at every animation frame around the trigger.
- correlate visual evidence with server and broker timestamps to determine whether divergence begins in prefill delivery, terminal writes, hydration gating, layout/fit, disposal, or CSS reveal.
- test one ranked hypothesis at a time with the smallest reversible experiment; record what would confirm and disprove it before running the experiment.
- if no branch delta explains the result, explicitly test deployment/cache mismatch and browser/GPU variance before modifying rendering code.

## 4. Lock the defect into a regression and fix its source
- create the smallest real-browser regression that reproduces the measured failure predicate; avoid asserting only implementation details or replacing the relevant terminal behavior with mocks.
- prove the regression fails on the causal revision and passes on the known-good revision before changing production code.
- implement one minimal source-level fix at the first divergent state transition; do not tune hydration constants unless timing itself is proven causal.
- remove temporary diagnostics or retain only gated, generally useful telemetry with bounded storage and no session-content exposure.

## 5. Verify and decide pr #176 independently
- rerun the reproduction matrix across cold/warm cache, desktop/mobile, solo/grid, reconnect, resize, and long-scrollback session switching.
- run focused session-switch/hydration tests, the complete Playwright suite, Bun tests with bounded concurrency, Rust tests, typecheck, generated-asset verification, and `git diff --check`.
- evaluate pr #176 against both defects: its intended mobile scrollback preservation and the flicker predicate. full prefill must not be treated as a flicker fix without evidence.
- evaluate the already-distinct #176 merge (`3b83088`) for compatibility; preserve its visible behavior and rollback boundary, documenting any conflict instead of rewriting or omitting it.
- report reproduction rate before/after, confirmed root cause, evidence that falsified alternatives, residual risk, and the exact deployed bundle/binary hashes.

## final verification ledger
- regression red: merged `3b83088` mobile switch exposed partial full-prefill content before `prefill_done`; pre-merge `fc94d22` mobile viewport switch passed. desktop pre-merge full mode reproduced the latent bug. reconnect red on the partial fix observed `{ loadState: "live", visibility: "visible", opacity: "1" }` before completion.
- regression green: final switch + reconnect regression passed on iPhone SE, iPhone 14, and desktop Chromium.
- repetition matrix: pre-fix 119/120 early reveals across four 30-run desktop/mobile cold/warm cohorts; fixed 0/120.
- focused session switch: 23 passed, 31 skipped.
- focused grid/reconnect/resize/scrollback: 15 passed, 3 skipped; real-broker m0/m2/m4 desktop scroll-lock passed and both mobile shell/TUI reconnect tests passed on each revision.
- full Playwright: 76 passed, 89 skipped (`bun run test:e2e -- --reporter=line`).
- full Bun: 1,690 passed, 0 failed with bounded concurrency and per-command Git signing disabled. an earlier run's sole failure was the external 1Password Git signer; no repository config was changed.
- full Rust: 174 passed, 0 failed.
- typecheck: root and public TypeScript projects passed.
- generated assets: regeneration was byte-stable; embedded app bundle equals `public/app.bundle.js` at sha-256 `6e8a2cd7833b104bf6518c1ad8c14de5cca860270e93197a24473fa01453cd7c`.
- hygiene: `git diff --check` passed. final tracked scope is `public/app.ts`, `src/public-assets.ts`, and `tests/e2e/session-switch.e2e.ts`; plans remain untracked. `.plans/001-merge-pr176-deploy.md` remains unchanged at sha-256 `a535ffe21f3fcd7f5799aef77c3eeb5d8206d741d6aa1540b7567a96a01ec9cf`.
- residual risk: if a full-prefill connection remains open forever without `prefill_done`, the terminal now remains safely hidden instead of revealing partial content. the production server guarantees `prefill_done` on successful delivery and disconnect/reconnect handles failed delivery; a dedicated full-prefill protocol deadline could be a separate reliability enhancement.
- deployment at investigation handoff: intentionally not performed. the running service served the verified pre-fix merge bundle; fixed hashes above were local build identities only.

review remediation:
- review reproduced a forced-completion regression: viewer conflict left hydration pending and emitted 67 `hydration.holdInitialContent` events in 1.4 seconds.
- regression tests were added first for viewer-conflict forced completion and a full-prefill socket that never sends `prefill_done`; both failed before remediation.
- hydration now has an explicit `forceFinish()` path used by solo and grid conflict overlays, while normal `finish()` retains the hard protocol-completion gate.
- incomplete protocol content no longer schedules a 16ms polling loop; `onPrefillDone` remains the event-driven completion trigger.
- every prefill attach now has a 15-second protocol deadline. timeout closes with typed code `4003` / reason `prefill timeout`, and the existing disconnect classifier routes it through reconnect without revealing partial content.
- final focused flicker/conflict/timeout verification: 5 passed, 4 skipped across desktop and mobile profiles.
- final full Playwright: 78 passed, 93 skipped.
- final full Bun: 1,690 passed, 0 failed; final Rust: 174 passed, 0 failed.
- final typecheck, deterministic asset regeneration, and `git diff --check`: passed.
