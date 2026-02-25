# Wolfpack Solo-Builder UX Roadmap

## Purpose

Define a complete, implementation-ready UX roadmap for Wolfpack as a solo-builder terminal command center.

Primary outcome:
- Decide exactly what to build before coding.
- Keep session sharing and multi-user collaboration out of scope.
- Prioritize mobile terminal speed, clarity, and control.

## Product Direction (Locked)

- Persona: solo builders running coding agents across one or more personal machines.
- Core surfaces: session list, terminal view, machine management, notifications.
- Security model: existing local + Tailscale access model.
- Out of scope:
  - Shared sessions with collaborators
  - Roles/permissions
  - Public invite links
  - Presence indicators for other users

## Decision Lock-In (2026-02-24)

User-selected decisions:
- `1B` Mobile transport: WS only, no polling fallback.
- `2A` Prompt actions v1: `Yes/No/Enter/Ctrl+C` only.
- `3A` Draft persistence: per-device/browser localStorage only.
- `4B` Session triage labels: full set (`needs input/error/running/idle`).
- `5A` Notifications default: prompts + errors.
- `6B` Quick command palette: defer to Phase B.
- `7B` Input safety: configurable Enter behavior now.
- `8A` Readability controls: include in first release wave.
- `9A` Experimental features: skip for now.
- `10A` Milestone success: explicit measurable targets.

Round 2 lock-in:
- `R2-1B` WS failure state: blocking error screen after retry budget is exhausted.
- `R2-2B` WS retry policy: stop automatic retries after 2 minutes.
- `R2-3B` Prompt payload semantics: `Yes -> yes + Enter`, `No -> no + Enter`.
- `R2-4A` Running vs idle threshold: running if output/input activity within last 20s.
- `R2-5A` Haptics: single global vibration pattern for now.
- `R2-6A` Enter mode default: keep current mobile default (`Enter = newline`).
- `R2-7A` Readability presets: `small 12/1.35`, `medium 13/1.45`, `large 14/1.55`.
- `R2-8A` KPI targets: accept current explicit targets as-is.

## Current State Summary

Based on current code:
- Mobile terminal uses `/api/poll` loop (text snapshot from `tmux capture-pane`).
- Desktop uses `xterm.js` + `/ws/pty` with near-real-time interaction.
- Notifications exist and are pattern-based.
- Multi-machine list/switching exists and works.
- Session drawer exists and is mobile-optimized.

Main gaps for solo UX:
- Mobile terminal latency and visual jitter under rapid output.
- Input ergonomics for common agent prompts.
- Interrupt/recovery behavior after backgrounding or weak network.
- Limited triage signals in session list.

---

## Feature Backlog (Everything We Can Add)

Priority definitions:
- P0: high impact, low risk, should ship first.
- P1: meaningful gains after P0.
- P2: polish and optional improvements.

## 1. P0: Core Terminal UX

## ~~1a. UX-01 Mobile terminal WebSocket stream (replace poll loop)~~

Goal:
- Make mobile feel as live as desktop.

Implementation:
- Add `/ws/mobile` endpoint (or reuse `/ws/terminal` with mobile-safe payload mode).
- Push incremental updates on changes with heartbeat and reconnect.
- Remove mobile `/api/poll` path from normal runtime flow.
- Add client reconnect with backoff and explicit states: `live`, `reconnecting`, `offline`, `session-ended`.
- Retry budget: stop automatic retries after 2 minutes and enter blocking `offline` state.
- Provide explicit `Retry now` action from blocking state.

Code touchpoints:
- `serve.ts` (`handleTerminalWs`, upgrade routes)
- `public/index.html` (mobile terminal data loop, reconnect state)

Acceptance criteria:
- No fixed-interval polling in mobile terminal mode.
- Mean visual latency under active output is materially lower than current poll mode.
- On connection drop, UI recovers without needing manual navigation.
- If reconnect budget is exhausted, user sees clear blocking recovery UI (not silent failure).

Tests:
- Integration test for WS connection + update delivery.
- Integration test for reconnect and session end behavior.
- Manual test on mobile Safari and Chrome Android.

Risk:
- Resize race with desktop PTY; must preserve current resize protections.

---

## ~~1b. UX-02 Prompt-aware quick action bar~~

Goal:
- Reduce typing friction on phone during agent prompts.

Implementation:
- Detect prompt patterns in recent terminal lines (existing attention patterns can be reused/extended).
- Show contextual chips above input bar, such as:
  - `Yes`
  - `No`
  - `Enter`
  - `Ctrl+C`
- Chip send semantics:
  - `Yes` sends `yes` + Enter
  - `No` sends `no` + Enter
  - `Enter` sends Enter key
  - `Ctrl+C` sends `C-c`
- One tap sends key/text safely through existing API.
- Chips disappear when prompt no longer matches.

Code touchpoints:
- `public/index.html` (pattern parser + UI + send handlers)
- `serve.ts` (no required API changes)

Acceptance criteria:
- Chips only appear on relevant prompts.
- Chip tap success rate is equivalent to manual input path.
- No accidental repeated sends from stale matches.

Tests:
- Unit tests for prompt classifier (new test file).
- Manual tests against common agent prompts and CLI confirmations.

Risk:
- False positives; pattern tuning required.

---

## 1c. UX-03 Per-session draft persistence

Goal:
- Never lose in-progress input when switching sessions or backgrounding app.

Implementation:
- Keep input draft per `machine|session` in localStorage.
- Restore draft when opening session.
- Clear draft on successful send.
- Optionally support explicit "discard draft".

Code touchpoints:
- `public/index.html` (draft store/load lifecycle hooks)

Acceptance criteria:
- Switching sessions preserves unsent text.
- Browser/app background and return preserves draft.
- Draft never appears in wrong session.

Tests:
- Manual test matrix for session switching and refresh/reopen.

Risk:
- LocalStorage size edge cases (low risk due small payload).

---

## 1d. UX-04 Terminal follow mode + scroll lock

Goal:
- Improve readability when user scrolls up through output.

Implementation:
- Explicit follow-mode indicator (following vs paused).
- Auto-disable follow when user scrolls up.
- "Jump to live" button re-enables follow and scrolls to bottom.

Code touchpoints:
- `public/index.html` terminal scroll handling

Acceptance criteria:
- Output does not yank viewport while user is reading history.
- Returning to live output is one tap.

Tests:
- Manual tests during high-volume output streams.

Risk:
- Minimal.

---

## 1e. UX-05 Session triage signals in list

Goal:
- Help solo builders decide where to look first.

Implementation:
- Add per-session badges:
  - needs input
  - running
  - error hint
  - idle
- Reuse last lines and pattern matcher; avoid heavy parsing.
- Running/idle threshold:
  - `running` if terminal activity (captured output change or local input send) in last 20 seconds
  - otherwise `idle` unless promoted by prompt/error classification
- Sort defaults:
  1. needs input
  2. errors
  3. active
  4. idle

Code touchpoints:
- `serve.ts` `/api/sessions` metadata enrichment
- `public/index.html` list rendering + grouping

Acceptance criteria:
- Triage order feels deterministic and useful.
- No obvious misclassification on common agent flows.

Tests:
- Integration test for API metadata shape.
- Manual validation against sample sessions.

Risk:
- Over-classification noise if patterns are too broad.

---

## 2. P1: Reliability and Flow Improvements

## 2a. UX-06 Smarter reconnect model

Goal:
- Make interruptions predictable and less disruptive.

Implementation:
- Unified state model: `live`, `reconnecting`, `offline`, `session-ended`.
- Exponential backoff + jitter.
- Manual "reconnect now" action required.
- Better banner copy by state.
- Automatic retry budget capped at 2 minutes before entering `offline` blocking state.

Code touchpoints:
- `public/index.html` connection state machine

Acceptance criteria:
- State labels are accurate and stable.
- No stuck "reconnecting..." states after recovery.

---

## 2b. UX-07 Input safety for accidental sends

Goal:
- Reduce accidental command submission from mobile keyboard behavior.

Implementation:
- Configurable behavior:
  - Enter newline / Shift+Enter send (current mobile default)
  - Enter send / Shift+Enter newline
- Default mode on first install: Enter newline / Shift+Enter send.
- Optional "hold to send" for large messages.
- Optional confirm step for destructive commands (`rm`, `git reset --hard`, etc.) in mobile UI only.

Code touchpoints:
- `public/index.html` settings + key handlers

Acceptance criteria:
- Mode is explicit and sticky per device.
- No regression in existing fast-send flow.

Risk:
- Extra friction if too aggressive.

---

## 2c. UX-08 Quick command palette (solo macros)

Goal:
- Speed repetitive actions for a single user.

Implementation:
- Add user-defined quick command chips in terminal view.
- Defaults:
  - `status`
  - `tests`
  - `build`
  - `continue`
- Per-machine overrides optional (phase 2).

Code touchpoints:
- `public/index.html` settings + command dispatch
- Maybe `~/.wolfpack` config API if server persistence is preferred

Acceptance criteria:
- Creating/editing/reordering quick actions is simple on mobile.
- One-tap run sends expected text + Enter.

---

## 2d. UX-09 Session pinning and recents

Goal:
- Faster navigation between primary work sessions.

Implementation:
- Pin/unpin sessions.
- Recents queue with last-opened timestamp.
- Session drawer can switch between `Pinned` and `All`.

Code touchpoints:
- `public/index.html` local persistence + drawer render

Acceptance criteria:
- Pinned sessions stay at top regardless of machine sort.
- Recents reflect actual open behavior.

---

## 2e. UX-10 Notification controls by severity

Goal:
- Keep attention alerts useful, not noisy.

Implementation:
- Separate toggles:
  - prompts requiring input
  - errors/failures
  - all activity off
- Cooldown/dedupe window per session + signal type.
- Quiet hours (local device time).
- Haptics: keep single global vibration pattern in this phase (no severity-specific pattern map yet).

Code touchpoints:
- `public/index.html` notification logic + settings

Acceptance criteria:
- Repeated identical prompts do not spam notifications.
- User can dial notification sensitivity cleanly.

---

## 3. P2: Advanced Solo Experience and Polish

## 3a. UX-11 Inline command snippets from terminal context

Goal:
- Surface likely next actions based on current terminal context.

Implementation:
- Lightweight local heuristics only (no remote AI call required).
- Example: if `npm ERR!`, show snippets: `npm ci`, `npm run test`, `cat package.json`.

Risk:
- Wrong suggestions can annoy; should be dismissible.

---

## 3b. UX-12 Better terminal rendering controls

Goal:
- Improve readability across different phone screens.

Implementation:
- Settings for font size presets, line height, wrap behavior.
- Optional alternate monospace font stack.
- Optional reduced effects mode independent of global animation setting.
- Locked mobile presets:
  - small: font-size 12px, line-height 1.35
  - medium: font-size 13px, line-height 1.45
  - large: font-size 14px, line-height 1.55

---

## 3c. UX-13 Session timeline markers

Goal:
- Faster "what changed since last check?" scan.

Implementation:
- Local markers for key events:
  - opened
  - prompt detected
  - error detected
  - command sent
- Show compact timeline in terminal header or drawer detail.

---

## 3d. UX-14 Recovery snapshots

Goal:
- Handle app crashes/reloads without losing context.

Implementation:
- Persist minimal per-session terminal tail snapshot.
- On reopen, show cached tail immediately while live stream reconnects.

---

## 3e. UX-15 Mobile keyboard accessory row

Goal:
- Faster special-key entry on iOS/Android.

Implementation:
- Sticky accessory keys:
  - `Tab`
  - `Esc`
  - `Ctrl+C`
  - arrows
  - pipe/slash quick inserts (optional)
- Should not hide primary input field.

---

## 4. Cross-Cutting Work

## 4a. UX-16 Performance budget and telemetry

Goal:
- Measure if UX changes are actually better.

Implementation:
- Local lightweight metrics:
  - terminal update latency estimate
  - reconnect count
  - send failure count
  - dropped frame proxy (optional)
- Debug panel in settings (hidden unless enabled).

---

## 4b. UX-17 QA harness and regression tests

Goal:
- Keep terminal behavior stable as features are added.

Implementation:
- Expand integration coverage:
  - mobile WS lifecycle
  - prompt action dispatch
  - reconnect transitions
- Add Playwright mobile viewport scripts for critical flows.

---

## Recommended Delivery Sequence

Phase A (must-have):
- UX-01, UX-02, UX-03, UX-04, UX-05, UX-07, UX-12

Phase B (stability and speed):
- UX-06, UX-08, UX-10, UX-17

Phase C (polish and optional power):
- UX-09, UX-15

Phase D (experimental):
- UX-11, UX-13, UX-14, UX-16

Current cycle policy:
- Do not schedule Phase D work until Phases A and B are complete and re-approved.

## Proposed Milestone Definitions

M1: Mobile terminal feels truly live
- Includes UX-01 + UX-04

M2: Input friction reduced materially
- Includes UX-02 + UX-03 + UX-15 (optional)

M3: Solo triage and focus loop improved
- Includes UX-05 + UX-10 + UX-09

M4: Reliability hardening complete
- Includes UX-06 + UX-17 + selected polish

## Engineering Notes

- Keep architecture simple: do not introduce heavy frameworks.
- Favor incremental API additions over large protocol redesign.
- Keep `/api/poll` route for legacy compatibility only; mobile UI should not use it.
- Maintain backward compatibility with existing install base.
- Respect current security constraints and origin checks.

## Out-of-Scope Guardrails

Do not build in this roadmap:
- Multi-user collaboration presence
- Session sharing links
- Role-based session ownership
- Remote clipboard sync between users

## Explicit Success Targets
These are locked thresholds for the first implementation wave.

- Mobile terminal update latency:
  - p50 <= 180ms
  - p95 <= 450ms
- Reconnect recovery:
  - transient network drop recovers to `live` in <= 5s (p95)
- Input reliability:
  - prompt quick-action dispatch success >= 99% in manual QA runs
- Stability:
  - no session-switch draft leakage across `machine|session` keys
- Triage quality:
  - classifier correctness >= 90% on curated prompt/error/running/idle fixtures

## Scope Freeze: Phase A Build List

Build now:
- UX-01 Mobile WS terminal (WS-only, no poll runtime path)
- UX-02 Prompt-aware quick actions (`Yes/No/Enter/Ctrl+C`)
- UX-03 Per-session local draft persistence
- UX-04 Follow mode + jump to live
- UX-05 Full session triage badges + sort
- UX-07 Configurable Enter behavior (default unchanged)
- UX-12 Readability controls with locked presets

Do not build now:
- UX-08 quick command palette (Phase B)
- UX-09 pinning/recents (Phase C)
- UX-11/13/14/16 experimental work (Phase D)

## Test Depth Lock-In

- Phase A: strict (integration + targeted unit + manual mobile QA pass).
- Phase B: moderate (integration for touched terminal flows + manual QA).
- Phase C: moderate (manual-first with focused regression checks).
- Phase D: not scheduled in current cycle.

## Definition of Ready (Before We Start Coding)

The implementation spec is ready when:
- All requirements decisions are locked.
- Phase A scope is frozen (included + excluded items).
- Acceptance criteria for each selected item are approved.
- Test depth is locked per section above.

Status:
- Spec is code-ready for Phase A implementation.

