# Complexity Report — Wolfpack Codebase

> Generated: 2026-05-12 (rev 4). Branch: fix/broker-zombie-recovery.
> Focus: overengineering, bloat, duplication, dead/vestigial code, layered indirection.
> Changes from rev 3: removed C13 (`sessionDirMap` deleted from `dev-dir.ts`); removed C15 (`prevPaneContent` cleanup already exists on both poll and kill paths — finding was stale at generation time); C1 explicitly deferred per maintainer decision (rev 3 already recommended deferring).

---

## Unnecessary Indirection / Pass-Through Layers

### C1. `BackendRouter` is a mostly-forwarding shim around `BrokerBackend` — DEFERRED
**Location:** `src/server/backend.ts`
**Status:** Deferred per maintainer decision (2026-05-12). The shim earns its keep post-`f27d436` via lifecycle/recovery logic (watchdog + handshake plumbing + nil-broker guard). Revisit only when broker-side BS1–BS4 work forces further recovery layers — at that point either rename `BackendRouter` → `BrokerSupervisor`, or fold the watchdog+probe into a dedicated supervisor and let `BrokerBackend` be used directly.
**Description:** Most method bodies are one-liners delegating to `this.broker`. The wrapper adds (a) the nil-broker guard, (b) broker-socket probe / handshake plumbing, and (c) the 5s recovery watchdog. "Thin shim" comment at the top of the file is out of date.

---

### C2. `SessionBackend` interface maintained for a single real implementor
**Location:** `src/server/backend.ts:19–55`, `src/server/broker-backend.ts`, `src/server/mock-backend.ts`
**Description:** The `SessionBackend` interface exists to allow `MockBackend` to substitute for `BrokerBackend` in tests. `MockBackend` implements the interface with a flat `Set<string>` and test-only hooks; it never ships to production. The cost is maintaining a 10-method interface + duplicate method signatures across `BackendRouter` (forwarding) + `BrokerBackend` (real) + `MockBackend` (fake). A simpler approach: dependency injection directly into server modules for tests, without a named interface layer.
**Weight:** 3 implementations of the same interface, 2 of which are purely mechanical.

---

### C3. `PtyBackendMethods` is a separate interface for no compositional reason
**Location:** `src/server/backend.ts:56–91`
**Description:** `PtyBackendMethods` defines `onSessionData`, `writeToTerminal`, `getSessionPrefill`, `isSessionAlive`, `onSessionLifecycle`. `BrokerBackend` implements both `SessionBackend` and `PtyBackendMethods`. The split exists because `websocket.ts` calls `getStreamingBackendForSession()` which returns the backend cast to `PtyBackendMethods`. This requires a double interface + a dedicated accessor method, when `BrokerBackend` could simply be the single concrete type used directly by `websocket.ts`.
**Weight:** Extra interface, extra cast, extra accessor method with no behavioral distinction.

---

## Files That Do Too Much

### C4. `src/server/routes.ts` is 1042 lines of heterogeneous concerns
**Location:** `src/server/routes.ts:1–1042`
**Description:** A single file contains: settings CRUD, session lifecycle, git operations (branch list, fetch, checkout), ralph orchestration (start, cancel, dismiss, task-count, log), push notification management, peer aggregation, and manifest serving. These 12+ domains share no state and have no coupling reason to coexist. The file grew by accretion and is now effectively a mini-monolith.
**Impact:** Any change to ralph logic touches the same file as push subscription logic. Test isolation is poor — `ralph-api.test.ts` is 1683 lines because it must exercise the whole file.

---

### C5. `src/ralph-macchio.ts` is 1122 lines with 30+ functions at file scope
**Location:** `src/ralph-macchio.ts`
**Description:** The ralph worker script combines: plan parsing (`readPlan`, `extractCurrentTask`, `numberPlanTasks`), git/worktree orchestration (`getCurrentBranch`, `worktreeBranchName`, `createMainWorktree`, `mergeTaskBranch`, `cleanupTaskWorktree`), process management (`runIteration`, `shutdownHandler`), prompt building (`buildPrompt`, `buildRecoveryPrompt`), srt sandbox setup (`writeSrtSettings`, `cleanupSrtSettings`), log helpers (`logSummary`, `cleanupIterFile`), and the main loop (`main`). All at file scope with module-level mutable state. The plan-parsing functions partially duplicate logic already in `src/wolfpack-context.ts`.
**Impact:** Testing individual concerns requires running the whole script or extracting and re-testing logic that already has tests via `wolfpack-context.ts`.

---

### C6. `public/app.ts` is 4411 lines with mixed UI, state, and protocol concerns
**Location:** `public/app.ts`
**Description:** The main frontend file contains WebSocket protocol handling, terminal lifecycle, mobile keyboard proxy, grid mode transitions, sidebar behavior, session list rendering, ralph view management, push notification wiring, and keyboard shortcuts. The comment at the top acknowledges this with the split into `app-grid.ts`, `app-ralph.ts`, `app-touch.ts`, and `app-state.ts` — but `app.ts` still contains ~3900 lines of mixed responsibilities. `createPtyTerminalController`, `createTerminalInstance`, `createPtySocketClient`, and `createInitialHydrationController` are all defined and used exclusively in `app.ts` but are complex enough to be standalone modules.
**Impact:** Any feature touching the terminal attach path requires navigating a 4411-line file.

---

## Duplicated Logic

### C7. Plan parsing logic split between `wolfpack-context.ts` and `ralph-macchio.ts`
**Location:** `src/wolfpack-context.ts:88–115`, `src/ralph-macchio.ts:182–295`
**Description:** `wolfpack-context.ts` exports `countTasksInContent`, `validatePlanFormat`, `detectOldPlanFormat`. `ralph-macchio.ts` defines `readPlan`, `extractCurrentTask`, `numberPlanTasks`, `areAllTasksDone`, `taskSectionHeader` — all of which re-implement plan parsing against the same format spec. `numberPlanTasks` calls an external `wolfpack worker number-tasks` subprocess rather than directly calling `countTasksInContent`. The logic for detecting completed tasks (`~~` strikethrough, progress.txt matching) is re-implemented rather than shared.
**Weight:** ~150 LOC of plan parsing in `ralph-macchio.ts` that duplicates or reimplements concepts in `wolfpack-context.ts`.

---

### C8. Snapshot size cap applied in TypeScript but not in Rust
**Location:** `src/server/broker-backend.ts:45` (`scrollback_lines: 500`), `broker/src/server.rs` (no byte cap)
**Description:** `fetchSnapshot` caps scrollback at 500 lines client-side to avoid blowing the 64MB frame limit. The Rust broker applies no byte-level cap — it serializes whatever lines it has. The cap is documented only in a comment and must be kept consistent manually. A single cap at the broker level would be safer and remove the TS-side magic number.
**Weight:** Duplicate cap logic maintained across two languages.

---

### C9. `MockBackend.capturePaneForTriage` delegates to `capturePane` which re-strips ANSI
**Location:** `src/server/mock-backend.ts:86–88`
**Description:** `capturePaneForTriage` calls `this.capturePane(name)` which calls `stripAnsi(await this._capturePane(name))`. The real `BrokerBackend` has separate `capturePane` and `capturePaneForTriage` implementations. The mock conflates them, and strips ANSI twice when called through triage (once in `capturePane`, once in the already-stripped triage path). This is harmless but idiosyncratic.
**Weight:** Minor but reveals the mock diverges from the real implementation semantics.

---

## Premature Configurability / Dead Configurability

### C10. `BrokerClient` reconnect parameters are configurable but always defaulted
**Location:** `src/broker/client.ts:48–52`, `src/server/backend.ts:128–140`
**Description:** `BrokerClientOpts` exposes `reconnectInitialDelayMs` and `reconnectMaxDelayMs`, but `startBrokerClient()` in `BackendRouter` passes no overrides — always uses the defaults (100ms, 5000ms). No test exercises non-default values. These options add API surface and code paths that are never used in production.
**Weight:** 4 parameters, 2 stored fields, 2 defaulting checks — all dead in production.

---

### C11. `createServerInstance()` factory used for test isolation but adds a module singleton too
**Location:** `src/server/index.ts:103`, `src/server/index.ts:284`
**Description:** `createServerInstance()` was created to let tests spin up isolated instances. The module also exports a module-level `server` and `wss` singleton created via the same factory at module load. This means there are two code paths to the same thing, and the module-level singleton is created unconditionally on import (even in tests that want to use only the factory). The comment "for graceful shutdown from CLI" explains it but the dual-path is a confusing footgun.
**Weight:** Singleton created at import time regardless of caller needs.

---

### C12. `effectiveCmds` and `effectiveAgentCmd` are separate functions that both read settings
**Location:** `src/server/routes.ts:257–278`
**Description:** `effectiveAgentCmd(s)` computes the resolved agent command. `effectiveCmds(s)` returns the full command list for the UI picker. Both are called together on every `/api/settings` response and on settings update. They share the `enabled` filter computation but don't share code — there's a small duplication of the "find enabled commands" logic.
**Weight:** Minor (~10 LOC), but the API surface is confusing (callers must know to call both).

---

## Dead Code / Vestigial Paths

### C14. `ptySpawnAttempts` map is test-only but allocated in production
**Location:** `src/server/websocket.ts:37`
**Description:** `ptySpawnAttempts: Map<string, number>` is documented "test-only spawn counter." It is incremented on every `setupNewPtyEntry` call but serves no production purpose (no rate limiting, no alerting). It's exported only via `__getTestState()` which is test-only. The allocation, increment, and export are pure production overhead for a test fixture.
**Weight:** Dead map in production; incremented on every PTY creation.

---

### C16. `_wfTrace` diagnostic infrastructure always on, with no production value
**Location:** `public/app.ts:89–100`
**Description:** `window.__wfTrace`, `window.__wf_dumpTrace`, `window.__wf_clearTrace` are installed on `window` on every page load. The tracer records per-session attach metadata in a circular buffer. There is no flag to disable this in production; it is always active. This constitutes always-running dead code from a production standpoint (the tracer is only useful during debugging).
**Weight:** Small per-attach overhead, global namespace pollution, security surface (exposes session metadata to any JS context).

---

## Excessive Layering in Build Pipeline

### C17. Bundle pipeline has three separate scripts that could be one
**Location:** `scripts/bundle-app.ts`, `scripts/bundle-client-lib.ts`, `scripts/bundle-ghostty.ts`
**Description:** Three separate 50–120 line scripts each do roughly: "call `Bun.build()`", "post-process output with regex", "write file." They share no code despite identical structure. `gen-assets.ts` then calls all three sequentially as subprocesses. This adds three process spawns, three file reads, three pattern-matching post-processors, and three output writes where one coordinated bundling script would suffice.
**Weight:** ~300 LOC of near-identical structure; `gen-assets.ts` would be simpler if bundling were inlined.

---

### C18. Export-stripping regex in `bundle-app.ts` is fragile and assumption-heavy
**Location:** `scripts/bundle-app.ts:39–40`
**Description:** After bundling, the script strips `export { ... }` blocks with a regex so all symbols stay at global scope (required for inline `onclick` handlers). The regex `/export\s*\{([^}]+)\}/` assumes single-line export blocks — Bun currently emits these, but this is not a documented guarantee. A build format change in a Bun upgrade would silently produce broken output (extra `export` lines at global scope causing a parse error in the browser).
**Impact:** Brittle: any Bun change that emits multi-line export blocks breaks the frontend silently.
