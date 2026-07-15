# agent-native `wolfpack session open` plan

**status:** implementation verified — deployment, live validation, and PR pending
**branch:** `feat/session-open` from merged `main` at `ed009b3`
**goal:** `wolfpack session open <project>` creates a numbered sub-agent using the parent session’s harness and automatically adds it beside the parent when an active browser is showing that parent in single-session mode.

**accepted contract:**
- require structured `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND`; never inspect process ancestry or terminal prose.
- reject missing context and `shell`/`unknown` harnesses; no harness override in v1.
- names are `<harness>-sub-agent`, `<harness>-2-sub-agent`, `<harness>-3-sub-agent`, preserving the postfix.
- exact project names only; project prefix filtering remains issue #178.
- creation succeeds when no matching browser is attached; grid notification is best-effort.
- browser remains the only grid/layout owner. The server delivers a typed event but stores no grid state.
- no initial prompt, remote-machine selection, persistent parent-child model, or browser automation in v1.

**success evidence:**
- a Pi parent creates `pi-sub-agent`, then `pi-2-sub-agent`, both running `pi` in the requested project.
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
- Update `skills/wolfpack-tailnet-control/SKILL.md` so natural open/create-sub-agent requests map directly to `wolfpack session open <project> --json` without local curl/UI discovery.
- Add skill-content tests and realistic trigger/workflow evals; after product verification, refresh the user’s shared dotfiles skill as a separate local rollout artifact.

## implementation status

- [x] cli parsing, structured context validation, numbering, collision retries, and json envelopes.
- [x] optional `parentSession` API validation and best-effort active-viewer notification.
- [x] generated HTTP/WebSocket control schemas and contract snapshots.
- [x] browser websocket dispatch split into binary, terminal-control, and application-event handlers.
- [x] single-parent automatic grid placement plus ignore-path Playwright coverage.
- [x] canonical docs and bundled tailnet-control skill workflow.
- [x] focused and full Bun/Rust/Playwright verification plus deterministic generation and build.
- [ ] isolated deployment, live validation, and PR.

## 5. Verify and deploy without restarting the broker

- Run focused CLI, API, WebSocket, browser, control-schema, docs, and skill tests, then typecheck and deterministic generation checks.
- Run the full Bun, Rust, and applicable Playwright suites with `git diff --check`.
- Build/install only the Wolfpack server/CLI binary and restart only `com.wolfpack.server`; record the broker PID before/after and require it to remain unchanged.
- Live-test Pi creation, numbered collision, real single→grid transition, no-viewer creation, JSON errors, and cleanup of all fixtures.
- Commit/push only after fresh verification; open a PR targeting `main`. Do not merge without explicit instruction.
