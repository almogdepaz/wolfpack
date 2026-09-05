# Hermes Async Compaction Context Engine Implementation Plan

> **For Hermes:** Execute this plan task-by-task with targeted tests before enabling it in the default profile.

**Goal:** Build and publish `hermes-async-compaction`, a Hermes Context Engine that precomputes a standard Hermes-compatible compaction summary after an eligible turn, validates it against the current transcript, and applies it only at a safe boundary.

**Architecture:** Ship a standalone Python plugin repository, `almogdepaz/hermes-async-compaction`. It implements the `ContextEngine` ABC while composing the installed Hermes `ContextCompressor` for current summary semantics, token accounting, failure cooldowns, and a synchronous fallback. A per-session background worker stores only an in-memory immutable snapshot plus a ready summary; transcript identity/version checks invalidate stale work before it can be handed to `compress()`.

**Tech stack:** Python 3.11+, Hermes Agent `ContextEngine` / `ContextCompressor`, `concurrent.futures.ThreadPoolExecutor`, pytest, GitHub release first; optional PyPI entry-point distribution after compatibility is proven.

---

## Current facts and hard constraints

- Hermes has a single active context engine (`context.engine`, current default: `compressor`). A replacement must implement `update_from_response()`, `should_compress()`, and `compress()` and maintain the engine token counters.
- Hermes provides `on_turn_complete()` for post-turn observation and invokes compaction in a host-managed thread with timeout protections. Plugin state must be thread-safe across sessions.
- Hermes can call `prune_tool_results_only()`, but this plugin must inherit the safe no-op. Do **not** add deterministic tool-result deletion in v1.
- The successful behavior to reproduce from Pi is background preparation plus safe validation—not Pi-specific APIs or code.
- A ready summary must never mutate the durable transcript directly. Only the normal Hermes compaction boundary may commit the replacement message list.
- Existing active config must remain `context.engine: compressor` until a complete test matrix and a manual dogfood run pass.

## Compatibility contract

1. No background job runs below an explicit async-start threshold.
2. The job snapshots immutable message content and a deterministic fingerprint; it never retains mutable session objects.
3. A ready result can apply only when the current candidate messages match the snapshot fingerprint and the same model/compaction settings are still active.
4. New messages, a model change, manual focused `/compress`, session reset, or any fingerprint mismatch makes the job stale and routes to ordinary synchronous compression.
5. Background failures, cancellation, timeout, malformed summary, and unavailable auxiliary provider all fail open to the built-in compressor.
6. The extension must not do one LLM call per completed turn. It starts only once per eligible snapshot and uses a configurable start threshold/cooldown.
7. Never change prompt caching during normal turns. The job is observational until a real compaction boundary commits.

## Proposed repository layout

```text
hermes-async-compaction/
├── plugin.yaml
├── __init__.py
├── pyproject.toml
├── README.md
├── LICENSE
├── src/hermes_async_compaction/
│   ├── __init__.py
│   ├── engine.py
│   ├── state.py
│   ├── snapshot.py
│   ├── worker.py
│   ├── validation.py
│   └── config.py
└── tests/
    ├── conftest.py
    ├── test_engine_contract.py
    ├── test_snapshot.py
    ├── test_lifecycle.py
    ├── test_staleness.py
    ├── test_fallback.py
    └── test_install_smoke.py
```

## Task 1: Create the distributable plugin skeleton

**Objective:** Make the repository discoverable by Hermes without activating it.

**Files:**
- Create: `plugin.yaml`
- Create: `__init__.py`
- Create: `pyproject.toml`
- Create: `src/hermes_async_compaction/__init__.py`
- Create: `README.md`
- Create: `tests/test_install_smoke.py`

**Steps:**
1. Define manifest metadata: name `async-compaction`, version `0.1.0`, description, and no network/secret requirements.
2. Add a `register(ctx)` function that imports and registers `AsyncCompactionEngine` via `ctx.register_context_engine()`.
3. Use a `src/` Python package and pytest configuration. Declare Hermes as a compatibility dependency range rather than vendoring Hermes internals.
4. Write a smoke test that imports `register`, collects the engine, and verifies `engine.name == "async_compaction"`.
5. Run: `pytest -q tests/test_install_smoke.py`.

**Acceptance:** The plugin can be discovered with `hermes plugins list`, but remains inactive unless the context-engine selection is changed.

## Task 2: Build a strict built-in-compressor adapter

**Objective:** Preserve standard Hermes behavior for token tracking, thresholds, and synchronous compression.

**Files:**
- Create: `src/hermes_async_compaction/engine.py`
- Create: `src/hermes_async_compaction/config.py`
- Test: `tests/test_engine_contract.py`

**Steps:**
1. Instantiate or compose the installed `agent.context_compressor.ContextCompressor` behind the engine; do not duplicate Hermes summary prompts or compaction logic.
2. Delegate `update_from_response()`, model updates, status counters, `should_compress()`, and regular synchronous `compress()` behavior to the adapter when no valid ready result exists.
3. Explicitly implement `prune_tool_results_only()` as a no-op in v1.
4. Define plugin-owned configuration under `async_compaction`: `enabled`, `start_ratio`, `timeout_seconds`, `max_workers`, and `min_messages`. Defaults must keep behavior disabled until explicitly selected.
5. Add ABC contract tests plus parity tests proving that, with no ready job, the plugin returns the same result as the wrapped compressor fixture.
6. Run: `pytest -q tests/test_engine_contract.py`.

**Acceptance:** Selecting the engine without any completed background work behaves identically to built-in synchronous compaction.

## Task 3: Define immutable snapshot and staleness validation

**Objective:** Make stale or cross-session summaries impossible to apply.

**Files:**
- Create: `src/hermes_async_compaction/snapshot.py`
- Create: `src/hermes_async_compaction/validation.py`
- Test: `tests/test_snapshot.py`
- Test: `tests/test_staleness.py`

**Steps:**
1. Deep-copy only the exact prefix selected for compaction plus required protected head/tail metadata.
2. Compute a deterministic fingerprint over normalized OpenAI-format messages, active model identifier, relevant compressor settings, session ID, and snapshot boundary indices. Redact no messages inside the fingerprint; hash only in memory.
3. Define `Snapshot`, `ReadySummary`, and explicit invalidation reasons: `new_messages`, `model_changed`, `settings_changed`, `manual_focus`, `session_reset`, `summary_failed`, `timeout`, and `fingerprint_mismatch`.
4. Write tests for byte-identical match; single tool-result mutation; appended message; altered model; changed threshold; and changed focus topic.
5. Run: `pytest -q tests/test_snapshot.py tests/test_staleness.py`.

**Acceptance:** A ready result can only match exactly the context state it summarized.

## Task 4: Implement bounded background preparation

**Objective:** Begin one asynchronous summary only when useful, without blocking the response path.

**Files:**
- Create: `src/hermes_async_compaction/state.py`
- Create: `src/hermes_async_compaction/worker.py`
- Modify: `src/hermes_async_compaction/engine.py`
- Test: `tests/test_lifecycle.py`

**Steps:**
1. On `on_turn_complete(messages, usage, **kwargs)`, evaluate the async-start window from current usage and `start_ratio`.
2. If eligible and no equivalent job is pending/ready, snapshot context and submit exactly one worker to a bounded executor.
3. The worker calls the same summarized-compaction path used by the wrapped Hermes compressor, but produces an in-memory candidate result only; it must not call session persistence or mutate the live message list.
4. Guard engine state with a lock keyed by session ID. Cancel/invalidate jobs on session end/reset and model/settings changes.
5. Enforce a configurable timeout and record a compact lifecycle state (`idle`, `preparing`, `ready`, `stale`, `failed`) without recording prompts, terminal data, or full summaries to logs.
6. Test non-blocking post-turn behavior; deduped job starts; job timeout; job failure; reset cancellation; and concurrent independent session jobs.
7. Run: `pytest -q tests/test_lifecycle.py`.

**Acceptance:** Normal agent output continues while one eligible summary is prepared; no durable conversation state changes before a safe application boundary.

## Task 5: Hand off a ready summary through normal compaction

**Objective:** Apply only a validated prepared result, otherwise use Hermes’s normal compressor.

**Files:**
- Modify: `src/hermes_async_compaction/engine.py`
- Modify: `src/hermes_async_compaction/validation.py`
- Test: `tests/test_fallback.py`
- Test: `tests/test_lifecycle.py`

**Steps:**
1. In `should_compress()`, preserve the normal built-in threshold decision. A ready job never forces compaction below the standard safe boundary in v1.
2. In `compress()`, re-fingerprint current candidate messages and validate the model/settings/session/focus metadata.
3. If valid, return the precomputed result in the exact OpenAI message format expected by Hermes, increment counters once, and clear the ready state only after successful handoff.
4. If invalid, stale, missing, or failed, call the wrapped synchronous compressor and leave a concise diagnostic reason.
5. Make manual `/compress <focus>` always bypass prepared background summaries unless the exact focus was part of the snapshot.
6. Test valid apply, every invalidation reason, empty/malformed summary, manual focus, and normal fallback behavior.
7. Run: `pytest -q tests/test_fallback.py tests/test_lifecycle.py`.

**Acceptance:** No prepared summary can replace the wrong context; every failure path produces standard Hermes compaction or a no-op rather than transcript damage.

## Task 6: Add operator controls and observability

**Objective:** Make the extension understandable and reversible for users.

**Files:**
- Modify: `plugin.yaml`
- Modify: `src/hermes_async_compaction/engine.py`
- Create: `docs/configuration.md`
- Modify: `README.md`
- Test: `tests/test_engine_contract.py`

**Steps:**
1. Expose a read-only status tool or slash command only if Hermes’s context-engine command registration works in gateway and TUI surfaces; otherwise document structured log events.
2. Document configuration, behavior, thresholds, lifecycle states, cache tradeoffs, privacy policy, failure semantics, and exact rollback command.
3. Provide installation:
   ```bash
   hermes plugins install almogdepaz/hermes-async-compaction
   ```
   followed by explicit plugin enablement/engine selection where required by the installed Hermes version.
4. Provide rollback:
   ```bash
   hermes config set context.engine compressor
   ```
5. Add tests that configuration defaults do not auto-enable the engine and status never exposes prompt/tool-result content.

**Acceptance:** An operator can tell whether a job is preparing/ready, turn it off, and restore the built-in compressor without deleting session history.

## Task 7: Compatibility and dogfood gate

**Objective:** Prove the plugin against the installed Hermes version before publication.

**Files:**
- Create: `tests/test_real_hermes_smoke.py`
- Modify: `README.md`
- Create: `CHANGELOG.md`

**Steps:**
1. Run the upstream ContextEngine contract tests against the installed Hermes source, adapted only through fixtures.
2. Run a local long-session fixture that includes multi-tool turns, large terminal output, a model switch, an interrupted summary, a manual focused compression, and session reset.
3. Install the plugin into a temporary `$HERMES_HOME`; select it; run a disposable `hermes chat -q` smoke test; verify fallback and rollback.
4. Verify that `context.engine: compressor` continues to work after plugin installation.
5. Document the Hermes version matrix tested, known incompatibilities, and no-telemetry guarantee.
6. Run: `pytest -q` and the project’s lint/type-check commands.

**Acceptance:** All tests pass; no secret/prompt/session content appears in plugin logs; fallback and rollback work in a clean profile.

## Task 8: Release and publication

**Objective:** Publish an auditable v0.1.0 without claiming unsupported compatibility.

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Steps:**
1. Create public GitHub repository `almogdepaz/hermes-async-compaction` with MIT license, README, threat model, test matrix, and release notes.
2. Tag `v0.1.0` only after CI covers all lifecycle/fallback tests.
3. Validate consumer installation from a clean temporary Hermes home with `hermes plugins install almogdepaz/hermes-async-compaction`.
4. Do not publish to PyPI until Git installation, upgrade, and rollback have been used successfully across at least two Hermes releases.
5. For PyPI later, add the `hermes_agent.plugins` entry point and test package discovery in an isolated virtual environment.

**Acceptance:** A user can inspect source, install from Git, enable/select the engine, verify behavior, and roll back safely.

## Verification matrix

- Built-in fallback parity when no prepared result exists.
- One eligible background job; no duplicate worker per identical snapshot.
- Summary ready while context remains unchanged → valid handoff.
- New user/tool/assistant message → stale result rejected.
- Model or compression-setting change → stale result rejected.
- Manual focused `/compress` → prepared result bypassed unless exact-match support is deliberately added later.
- Background model error, timeout, cancellation, malformed summary → safe fallback/no-op.
- Two concurrent sessions → no state leakage.
- Reset/end → pending work cancelled and no late apply.
- No deterministic pruning or transcript mutation outside normal Hermes compaction.
- Clean plugin install, enable/select, disable, and rollback.

## Risks and decisions

| Risk | Mitigation |
| --- | --- |
| Context engine replaces built-in behavior | Compose/delegate to `ContextCompressor`; prove fallback parity before activation. |
| Background job races with live conversation | Immutable snapshots, per-session locks, fingerprint validation, and fail-open fallback. |
| Background call spends money without benefit | One job per snapshot, start threshold, strict invalidation, timeout, and lifecycle diagnostics. |
| Prompt-cache regression | Do not mutate/swap context until an ordinary compaction boundary; keep deterministic pruning out of v1. |
| Hermes API drift | Pin/test supported Hermes ranges; test against current release and next update before publishing. |
| User privacy | No telemetry; no prompt/session/tool payload logging; lifecycle events contain only state and duration. |

## Open questions to settle before Task 4

1. Which auxiliary model/provider should produce background summaries by default: reuse `auxiliary.compression`, or require an explicit plugin-specific opt-in?
2. Should ready summaries apply only at Hermes’s normal compaction threshold in v0.1 (recommended), or also after an idle window?
3. Does the current installed Hermes plugin manager discover a context engine registered from a user general plugin reliably, or should v0.1 ship as a source-tree/plugin-path installation until that behavior is tested?
4. What exact Hermes version range will v0.1 support?
