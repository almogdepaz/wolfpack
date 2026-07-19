# agent-native `wolfpack session open` plan

**status:** revised implementation, deployment, and live validation verified — ready to update PR #180
**branch:** `feat/session-open` from merged `main` at `ed009b3`
**goal:** `wolfpack session open <project>` creates a numbered sub-agent using the parent session’s harness and automatically adds it beside the parent when an active browser is showing that parent in single-session mode.

**accepted contract:**
- require structured `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND`; never inspect process ancestry or terminal prose.
- reject missing context and `shell`/`unknown` harnesses; no harness override in v1.
- names derive from the parent: `<parent>-sub-agent`, then `<parent>-sub-agent-2`, `<parent>-sub-agent-3`; preserve the suffix by truncating only an overlong parent prefix to the 100-character session limit.
- persist structured parent session ID/name metadata and use it for grouping; never infer parentage by parsing the child name.
- exact project names only; project prefix filtering remains issue #178.
- creation succeeds when no matching browser is attached; grid notification is best-effort.
- browser remains the only grid/layout owner. The server delivers a typed event but stores no grid state.
- no remote-machine selection or browser automation in v1.
- `session open --prompt <instruction>` passes one explicit instruction as an opaque harness argv value; it never inherits parent transcript/context/model state.

**success evidence:**
- a Pi parent named `wolfpack` creates `wolfpack-sub-agent`, then `wolfpack-sub-agent-2`, both running `pi` in the requested project.
- after successful creation, the active browser showing the parent as a single terminal transitions through the existing `addToGrid()` path.
- browsers on another parent/view or already in grid mode ignore the event.
- `--json` emits exactly one JSON success/error envelope and a deterministic exit code.
- deployment changes only the server/CLI binary; broker PID and existing PTYs remain unchanged.

## 1. Lock CLI behavior with failing tests

- Extend `tests/unit/session-control.test.ts` first for `open <project> [--json]`, required parent/harness context, rejected `shell`/`unknown`, unknown flags, and exact JSON envelopes.
- Add pure naming tests for first, sequential, sparse, and maximum-length candidates.
- Test structured session-list selection plus three HTTP-409 race retries without matching error prose.
- Define success as `{ ok: true, session, project, harness }`; define failures as `{ ok: false, error: { code, message } }` on stdout with nonzero existing `SESSION_EXIT` values.

## 2. Add the server-owned creation notification contract

- Extend `POST /api/create` with optional `parentSession`; validate it as a live session before creation when present.
- After successful child creation only, send `{ type: "sub_session_opened", parentSession, session }` to the active PTY viewer for the parent. Do not persist or infer browser layout.
- Extend `src/control-api/schema.ts`, regenerate `docs/generated/control-api.schema.json`, and update schema snapshots/contract tests.
- Add route/WebSocket tests proving validation, no event on failed creation, best-effort no-viewer behavior, and typed delivery to the matching active viewer.

## 3. Implement browser-owned automatic grid placement

- Add the new control-message type to the browser’s existing PTY message handling.
- Handle it only when terminal view is active, the current session equals `parentSession`, and grid mode is inactive; then call the existing `addToGrid(session)` path.
- Ignore duplicates, other parents, other views, and existing grids without mutating session/layout state.
- Add desktop Playwright regressions proving single parent → two-cell grid and all ignore cases, using the real browser message path rather than directly calling `addToGrid()`.

## 4. Implement and document the agent-facing CLI/skill workflow

- Extend `src/cli/session-control.ts` as a thin JWT-aware client: read active names, choose the candidate, and call `/api/create` with the project, current harness, generated name, and current parent session.
- Update `docs/session-control.md`, README, and `docs/agent-skills.md`; keep the detailed contract in `docs/session-control.md`.
- Update `skills/wolfpack-tailnet-control/SKILL.md` so natural open/create-sub-agent requests map directly to `wolfpack session open <project> --prompt '<instruction>' --json` without local curl/UI discovery or inherited transcript context.
- Add skill-content tests and realistic trigger/workflow evals; after product verification, refresh the user’s shared dotfiles skill as a separate local rollout artifact.

## implementation status

- [x] revise naming to parent-scoped `-sub-agent[-n]` names with collision retries and length preservation.
- [x] persist/expose structured parent identity and visually group child cards under their parent.
- [x] replace racy post-create terminal typing with an explicit launch-time `--prompt` argv contract.
- [x] cli parsing, structured context validation, collision retries, and json envelopes.
- [x] optional `parentSession` API validation and best-effort active-viewer notification.
- [x] generated HTTP/WebSocket control schemas and contract snapshots.
- [x] browser websocket dispatch split into binary, terminal-control, and application-event handlers.
- [x] single-parent automatic grid placement plus ignore-path Playwright coverage.
- [x] canonical docs and bundled tailnet-control skill workflow.
- [x] focused and full Bun/Rust/Playwright verification plus deterministic generation and build.
- [x] isolated deployment and live validation.
- [x] PR #180 opened; revised branch update pending.

## live verification evidence

- fresh full verification: Bun 1,722 passed; Rust 174 passed serially; Playwright 86 passed / 109 skipped; typecheck, production build, schema/assets determinism, and `git diff --check` passed.
- final server-only detached deployment: server PID `84873` → `19181`; broker PID remained `49523`.
- deployed/source bundle: `cc7e2b5b12f0488b6751238afe172dfbe5531e9fd313d8d0370b30d7fc454c5d`.
- all six pre-existing broker sessions retained the same names and session IDs through deployment and after fixture cleanup.
- superseded live finding: harness-scoped names (`pi-sub-agent`, etc.) did not communicate/group parent ownership; the revised contract uses parent-scoped names and structured identity.
- live prompt finding: an immediate `session send` inserted the review prompt but left it waiting for manual Enter; a later Enter executed it, proving harness startup readiness was the missing signal. The revised contract passes the instruction at process launch instead of typing into the PTY.
- live Pi launch created `launch-live-parent-sub-agent`; its explicit launch instruction executed without any follow-up terminal input and wrote the expected `launch-prompt-ok` marker.
- the second child was named `launch-live-parent-sub-agent-2`; both children exposed the same structured parent ID/name and rendered directly beneath the parent with child styling.
- active desktop parent transitioned from single terminal to a hydrated two-cell grid through the real WebSocket event path; an existing grid ignored the second child event.
- missing context, unsupported `shell`, inactive parent, and missing project each emitted exactly one structured JSON error line with exit code 3.
- live screenshot: `/Users/home/.dev-browser/tmp/session-open-live-grid.png`.
- all temporary parent/child sessions and the browser fixture were removed.

## 5. Verify and deploy without restarting the broker

- Run focused CLI, API, WebSocket, browser, control-schema, docs, and skill tests, then typecheck and deterministic generation checks.
- Run the full Bun, Rust, and applicable Playwright suites with `git diff --check`.
- Build/install only the Wolfpack server/CLI binary and restart only `com.wolfpack.server`; record the broker PID before/after and require it to remain unchanged.
- Live-test Pi creation, numbered collision, real single→grid transition, no-viewer creation, JSON errors, and cleanup of all fixtures.
- Commit/push only after fresh verification; open a PR targeting `main`. Do not merge without explicit instruction.
