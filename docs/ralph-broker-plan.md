# PLAN (ralph): persistent Rust PTY broker, full tmux removal

Ralph executes this file as the implementation plan for the final terminal architecture.

This is not a temporary migration or a stopgap plan.

The target end state is fixed:

- Bun Wolfpack server stays
- Rust broker daemon is added inside this repo
- broker is the only PTY/session owner
- browser connects to Wolfpack, Wolfpack connects to broker
- `tmux` is removed from the session execution path
- obsolete `tmux` and in-process PTY ownership paths are fully cleaned up after broker parity is reached

User decisions locked in:

- single interactive viewer per session
- take-control displaces the current viewer
- broker restart may kill sessions in v1
- browser reconnect must restore:
  - current visible screen correctly
  - prior scrollback transcript
  - ANSI-faithful terminal state
- browser copy must be practically usable
  - terminal-native selection is acceptable
  - transcript-backed copy UX is acceptable
- image paste is out of scope now, but the architecture must not block it later
- full test coverage is mandatory:
  - unit
  - integration
  - e2e
  - crash/restart recovery
  - resize/reconnect/TUI regressions

---

## Delivery rules

Ralph must not:

- introduce a new temporary persistence layer as the final result
- leave `tmux` as a hidden fallback in the final path
- ship a broker that only preserves child process liveness but not reconnect state quality
- reduce reconnect fidelity to plain-text-only state

Ralph may:

- sequence work by checkpoints
- keep old code temporarily during implementation
- delete old code only after equivalent broker behavior is landed and verified

---

## Architecture invariants

These are hard requirements, not suggestions.

1. Wolfpack does not own the lifetime of terminal child processes.
2. Broker is the sole PTY/session owner.
3. Reconnect state comes from one canonical broker-owned source.
4. Browser attach must not combine two separate history sources.
5. There is exactly one interactive viewer at a time.
6. Control messages and stdin bytes remain strictly separate.
7. Final system contains no `tmux` execution path.
8. Final system contains no in-process PTY session ownership path in Wolfpack.

---

## Checkpoints

Each checkpoint ends with explicit test gates. Ralph should not treat a checkpoint as complete until all listed gates are green.

Statuses:

- **[FULL]** Ralph completes end-to-end inside the sandbox.
- **[GATED]** Ralph lands code, then pauses for user-run or environment-dependent verification.

---

## 1. Define broker protocol and repo layout

[FULL]

Create the in-repo structure for the broker and write the protocol contract first.

Tasks:

- add top-level Rust crate for the broker
- choose directory layout and stick to it:
  - `broker/` preferred unless repo constraints force `crates/brokerd/`
- add protocol doc defining:
  - `list_sessions`
  - `create_session`
  - `kill_session`
  - `session_info`
  - `snapshot`
  - `write_stdin`
  - `resize`
  - `subscribe`
- define message/frame boundaries:
  - structured control plane
  - binary live-output plane
- define exact snapshot payload fields needed for reconnect

Acceptance:

- protocol document checked in
- Rust crate scaffolds build
- no Wolfpack runtime code changed yet

Tests:

- Rust unit tests for protocol serialization/deserialization

---

## 2. Implement broker daemon skeleton

[FULL]

Build the broker process skeleton without PTY session semantics first.

Tasks:

- daemon entrypoint
- Unix socket listener
- request router
- broker process lifecycle
- logging
- health/error handling for disconnected Wolfpack client

Acceptance:

- broker starts
- Wolfpack can connect to the socket
- stub protocol round-trips work

Tests:

- Rust unit tests for request routing
- integration test for socket connect/request/response lifecycle

---

## 3. Implement broker-owned session metadata and lifecycle

[FULL]

Add real session creation and ownership inside the broker.

Tasks:

- create PTY session from `cwd + cmd`
- persist broker-side metadata in memory:
  - name
  - cwd
  - command argv/string
  - pid
  - cols/rows
  - started-at
  - alive state
- enforce single source of truth for session existence
- implement kill/list/session-info routes

Acceptance:

- broker can create, list, inspect, and kill sessions without Wolfpack owning children
- broker is now the process parent for sessions

Tests:

- Rust unit tests for session registry behavior
- integration tests for duplicate names, kill semantics, liveness transitions

---

## 4. Implement canonical terminal state in broker

[GATED]

This is the critical checkpoint. Do not fake this with a plain byte ring.

Tasks:

- maintain terminal-state model inside broker
- maintain transcript tail
- maintain reconnect snapshot state
- snapshot must support:
  - current visible screen
  - scrollback transcript
  - ANSI-faithful state restoration target
- define and implement the internal state update pipeline from PTY output

Requirements:

- reconnect quality must satisfy the locked decision set
- broker state must be authoritative, not browser-local cache

Acceptance:

- broker can serve a snapshot for an active TUI session
- snapshot is sufficient to restore terminal state on reconnect

Tests:

- Rust unit tests for state update pipeline
- integration fixtures for:
  - plain shell output
  - carriage-return redraws
  - ANSI color/state changes
  - TUI-like partial redraw streams
- regression tests asserting snapshot correctness against fixture streams

User gate:

- manual broker-level validation against a real Claude TUI session
- confirm reconnect snapshot is not visually or semantically degraded

---

## 5. Add Wolfpack BrokerBackend

[FULL]

Integrate broker into Wolfpack through a dedicated backend implementation.

Tasks:

- add `BrokerBackend`
- map existing `SessionBackend`-style responsibilities to broker RPC
- broker-backed implementations for:
  - list
  - createSession
  - killSession
  - resize
  - sessionDir/session metadata
  - triage text capture source
- wire Wolfpack startup to broker availability

Acceptance:

- Wolfpack session APIs can operate against broker-owned sessions
- broker metadata cleanly replaces local PTY metadata needs

Tests:

- unit tests for `BrokerBackend`
- integration tests for create/list/kill/sessionDir/resize flows through Wolfpack

---

## 6. Replace `/ws/pty` attach path with broker streaming

[GATED]

This checkpoint replaces the current local PTY attach model.

Tasks:

- rewrite desktop attach/reconnect path to:
  - request broker snapshot
  - hydrate browser from broker snapshot
  - subscribe to broker live output
- forward browser stdin to broker
- forward browser resize to broker
- preserve single interactive viewer semantics and take-control behavior
- keep control-plane and binary stdin paths separate

Acceptance:

- Wolfpack no longer spawns a local PTY session for desktop attach
- live session data reaches browser through broker stream
- take-control still works with single interactive viewer semantics

Tests:

- unit tests for WebSocket control-path behavior
- integration tests for:
  - attach
  - reconnect
  - take-control
  - resize
  - session-ended paths
- e2e tests for:
  - shell session reconnect
  - Claude TUI reconnect
  - viewer displacement/take-control

User gate:

- manual desktop and mobile validation against a real Claude session

---

## 7. Add restart/crash recovery coverage

[GATED]

Prove the main requirement: Wolfpack restart does not kill broker-owned sessions.

Tasks:

- define restart test harness
- verify session survives Wolfpack process restart
- verify browser reconnect rehydrates correctly after Wolfpack restart
- verify broker restart behavior is explicit and tested as a failure boundary

Acceptance:

- automated proof that Wolfpack restart leaves session alive
- automated proof that reconnect state after restart is correct
- automated proof that broker restart may kill sessions in v1 and is surfaced cleanly

Tests:

- integration tests exercising server restart with live session
- e2e recovery tests across restart
- regression tests for:
  - current screen restoration
  - transcript restoration
  - ANSI/TUI restoration

User gate:

- manual restart verification using the installed service flow

---

## 8. Make browser copy practically usable

[GATED]

The exact UX is flexible. The outcome is not.

Tasks:

- choose one of:
  - true browser terminal selection/copy path
  - transcript-backed selection/copy path
- implement practical copy UX for desktop and mobile constraints
- ensure solution is compatible with broker-owned canonical state
- do not implement image paste here

Acceptance:

- users can practically select/copy text from the browser
- behavior works on the target UI paths

Tests:

- unit tests for copy helpers
- integration tests for transcript/copy APIs if added
- e2e tests for copy flow on desktop path
- mobile interaction coverage if selection UX is custom

User gate:

- manual browser copy validation on real target devices/browsers

---

## 9. Remove tmux from execution path

[FULL]

Once broker path is proven, remove `tmux` from actual session execution.

Tasks:

- stop creating new `tmux` sessions
- remove `tmux` backend from startup/backend selection
- remove `tmux` execution-path references from server logic
- remove `tmux`-specific WebSocket attach logic
- remove `tmux`-specific resize/history workarounds

Acceptance:

- no live code path can execute a Wolfpack session through `tmux`

Tests:

- unit/integration coverage updated to remove `tmux` assumptions

---

## 10. Full cleanup of obsolete paths

[FULL]

This checkpoint exists because full cleanup was explicitly requested.

Tasks:

- remove obsolete `tmux` code
- remove obsolete in-process PTY ownership code
- simplify backend routing to broker-only architecture
- delete dead tests that only exist for old backends
- replace them with broker-path coverage
- update docs and config semantics
- ensure install/uninstall/service flows include broker lifecycle cleanly

Acceptance:

- final architecture has one session owner: broker
- no stale fallback/backend-selection complexity remains
- docs match reality

Tests:

- full test suite green

---

## 11. Packaging and service integration

[GATED]

Broker must be built and shipped with Wolfpack and run as its own service, installed with or started by Wolfpack.

Tasks:

- add broker build to release/build pipeline
- ship broker artifact with Wolfpack
- wire install/start/stop/uninstall flows
- define service relationship between Wolfpack server and broker
- verify clean startup ordering and shutdown behavior

Acceptance:

- release artifacts include broker
- installed Wolfpack can run/start broker correctly
- broker service lifecycle is coherent on supported platforms

Tests:

- snapshot tests for generated service definitions if applicable
- integration tests for service wiring where possible

User gate:

- manual install/start/stop/uninstall verification on target platform(s)

---

## 12. Final regression pass

[GATED]

Run the full matrix the user explicitly asked for.

Required test categories:

- unit
- integration
- e2e
- crash/restart recovery
- resize/reconnect/TUI regressions

Scenario coverage must include at least:

- plain shell session
- Claude TUI session
- desktop attach
- mobile attach where relevant
- take-control displacement
- Wolfpack restart recovery
- broker restart failure boundary
- copy behavior

Acceptance:

- full matrix green
- no remaining `tmux` execution path
- no remaining in-process PTY ownership path

User gate:

- final manual signoff after end-to-end verification

---

## Execution order

Implement strictly in this order:

1. protocol and crate layout
2. broker skeleton
3. broker session lifecycle
4. canonical terminal state
5. Wolfpack BrokerBackend
6. `/ws/pty` broker streaming
7. restart/crash recovery
8. browser copy usability
9. remove `tmux` execution path
10. full cleanup of obsolete paths
11. packaging/service integration
12. final regression pass

No checkpoint may be skipped.

---

## Completion criteria

This plan is complete only when:

- broker is the only PTY/session owner
- Wolfpack restart leaves sessions alive
- reconnect restores visible screen + transcript + ANSI-faithful state
- take-control semantics still work
- browser copy is practically usable
- broker is shipped/managed with Wolfpack
- `tmux` path is gone
- old in-process PTY ownership path is gone
- full regression matrix is green

Awaiting go before execution.
